import { ToolError } from "../../errors.js";
import { attributesFromText, parseFastenerText } from "../../normalize.js";
import type {
  Availability,
  B2BPermission,
  Caller,
  CommerceBackend,
  CompanyContext,
  CustomerPrice,
  OrderDetail,
  OrderStatus,
  OrderSummary,
  Page,
  PartAttributes,
  ProductDetail,
  ProductSummary,
  QuoteDraft,
  QuoteDraftInput,
  RequisitionList,
  RequisitionListSummary,
  SearchQuery,
  SourceStock,
} from "../types.js";
import { CustomerTokenProvider, type CustomerAuth } from "./auth.js";
import { graphql, restGet, type FetchLike, type HttpOptions } from "./http.js";
import * as Q from "./queries.js";

export type AttributeKey = keyof Omit<PartAttributes, "standard">;

export interface PaasOptions {
  baseUrl: string;
  storeCode?: string;
  auth: CustomerAuth;
  /** Integration token limited to MSI read ACLs. Optional; without it stock is in/out only. */
  inventoryToken?: string;
  stockId?: number;
  /** source_code -> lead time in days (MSI has no standard lead-time field). */
  sourceLeadTimes?: Record<string, number>;
  /** Our attribute key -> the store's product attribute code. */
  attributeMap?: Partial<Record<AttributeKey, string>>;
  /** Storefront URL where buyers review negotiable quotes. */
  quoteReviewUrl?: string;
  timeoutMs?: number;
  fetch?: FetchLike;
}

// ---- GraphQL response shapes (only the fields we select) ----
interface Money {
  value: number | null;
  currency: string | null;
}
interface GqlPart {
  uid: string;
  sku: string;
  name: string | null;
  __typename: string;
  stock_status: "IN_STOCK" | "OUT_OF_STOCK" | null;
  only_x_left_in_stock: number | null;
  quantity: number | null;
  custom_attributesV2?: { items: Array<{ code: string; value?: string; selected_options?: Array<{ label: string }> }> } | null;
}
interface GqlAcl {
  id: string;
  children?: GqlAcl[] | null;
}
interface GqlOrder {
  number: string;
  order_date: string;
  status: string;
  email: string | null;
  total: { grand_total: Money } | null;
  items: Array<{
    product_sku: string;
    product_name?: string | null;
    quantity_ordered?: number | null;
    quantity_shipped?: number | null;
    product_sale_price?: { value: number | null };
  }> | null;
  shipments?: Array<{ tracking: Array<{ carrier: string; number: string | null; title: string }> | null }> | null;
}

/** Magento B2B company ACL resources -> the permissions our tools reason about. */
const ACL: Record<string, B2BPermission> = {
  "Magento_Sales::view_orders": "orders.view_own",
  "Magento_Sales::view_orders_sub": "orders.view_all",
  "Magento_NegotiableQuote::manage": "quotes.create",
  "Magento_RequisitionList::requisition_list": "requisition_lists.view",
  "Magento_Company::credit": "company.view_credit",
};
const ALL_PERMISSIONS: B2BPermission[] = ["catalog.view", ...new Set(Object.values(ACL))];

/** ACL ids come back either as the resource name or base64-encoded. */
function aclName(id: string): string {
  if (id.includes("::")) return id;
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8");
    return decoded.includes("::") ? decoded : id;
  } catch {
    return id;
  }
}

function flattenAcl(nodes: GqlAcl[] | null | undefined, out = new Set<string>()): Set<string> {
  for (const n of nodes ?? []) {
    out.add(aclName(n.id));
    flattenAcl(n.children, out);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const CONTEXT_TTL_MS = 60_000;

/**
 * Adobe Commerce PaaS adapter (2.4.7+ with B2B).
 *
 * Everything company-specific (visibility, price, orders, lists, quotes) goes
 * through storefront GraphQL as the company user, so Magento enforces shared
 * catalogs and company permissions. The only non-customer call is optional
 * MSI stock data, made with a separate least-privilege integration token and
 * only for SKUs the customer query has already shown are visible.
 */
/** Connection settings for the store, shared by the backend and the OAuth sign-in. */
export function paasHttp(opts: Omit<PaasOptions, "auth">): HttpOptions {
  return {
    baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    storeCode: opts.storeCode,
    timeoutMs: opts.timeoutMs ?? 15_000,
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
  };
}

export class PaasBackend implements CommerceBackend {
  readonly name = "paas";
  private readonly http: HttpOptions;
  private readonly tokens: CustomerTokenProvider;
  private readonly withAttrs: boolean;
  private context: { at: number; value: CompanyContext } | null = null;
  private sourceNames: Map<string, string> | null = null;

  constructor(private readonly opts: PaasOptions) {
    this.http = paasHttp(opts);
    this.tokens = new CustomerTokenProvider(this.http, opts.auth);
    this.withAttrs = Object.keys(opts.attributeMap ?? {}).length > 0;
  }

  private gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    return this.tokens.withToken((token) => graphql<T>(this.http, query, variables, token));
  }

  /** Verify (cached) that the token's user is the configured caller and a company member. */
  private async ensureCaller(caller: Caller): Promise<void> {
    await this.getCompanyContext(caller);
  }

  // ---------------------------------------------------------------- company

  async getCompanyContext(caller: Caller): Promise<CompanyContext> {
    if (this.context && Date.now() - this.context.at < CONTEXT_TTL_MS) return this.context.value;

    const data = await this.gql<{
      customer: {
        email: string;
        firstname: string | null;
        lastname: string | null;
        job_title: string | null;
        status: string | null;
        role: { name: string | null; permissions: GqlAcl[] | null } | null;
      } | null;
      company: {
        id: string;
        name: string | null;
        company_admin: { email: string | null } | null;
        payment_methods: string[] | null;
        sales_representative: { firstname: string | null; lastname: string | null; email: string | null } | null;
      } | null;
    }>(Q.companyContext);

    const c = data.customer;
    if (!c) throw new ToolError("FORBIDDEN", "The store did not recognise the company user's session.");
    // Guard against a token issued to someone other than the configured caller.
    if (c.email.toLowerCase() !== caller.email.toLowerCase()) {
      throw new ToolError(
        "FORBIDDEN",
        "The customer token belongs to a different user than COMMERCE_CALLER_EMAIL. Refusing to act.",
      );
    }
    if (!data.company) throw new ToolError("FORBIDDEN", "This customer is not a member of a B2B company.");
    if (c.status && c.status !== "ACTIVE") throw new ToolError("FORBIDDEN", "This company user is inactive.");

    const isAdmin = data.company.company_admin?.email?.toLowerCase() === c.email.toLowerCase();
    const granted = flattenAcl(c.role?.permissions);
    const permissions: B2BPermission[] = isAdmin
      ? ALL_PERMISSIONS
      : ["catalog.view", ...new Set(Object.entries(ACL).filter(([res]) => granted.has(res)).map(([, p]) => p))];

    let credit: CompanyContext["credit"] = null;
    if (permissions.includes("company.view_credit")) {
      const cr = await this.gql<{ company: { credit: { available_credit: Money; credit_limit: Money; outstanding_balance: Money } | null } | null }>(
        Q.companyCredit,
      ).catch(() => null);
      const k = cr?.company?.credit;
      if (k) {
        credit = {
          currency: k.credit_limit.currency ?? "",
          limit: k.credit_limit.value ?? 0,
          outstanding_balance: k.outstanding_balance.value ?? 0,
          available: k.available_credit.value ?? 0,
          exceed_limit_allowed: null, // not exposed to the storefront API
        };
      }
    }

    const rep = data.company.sales_representative;
    const value: CompanyContext = {
      company_id: data.company.id,
      company_name: data.company.name ?? "",
      user: {
        email: c.email,
        name: [c.firstname, c.lastname].filter(Boolean).join(" "),
        role: isAdmin ? "company_admin" : (c.role?.name ?? "unassigned"),
        job_title: c.job_title,
      },
      customer_group: null, // Customer.group is 2.4.9+; not queried so 2.4.7/2.4.8 work
      shared_catalog: null, // assigned server-side; not exposed to the storefront API
      permissions,
      credit,
      payment_on_account_enabled: (data.company.payment_methods ?? []).includes("companycredit"),
      sales_rep: rep?.email ? { name: [rep.firstname, rep.lastname].filter(Boolean).join(" "), email: rep.email } : null,
    };
    this.context = { at: Date.now(), value };
    return value;
  }

  // ---------------------------------------------------------------- catalog

  private attributes(p: GqlPart): PartAttributes {
    const fromName = attributesFromText(p.name ?? "");
    const map = this.opts.attributeMap;
    if (!map || !p.custom_attributesV2) return fromName;

    const label = (code: string | undefined) => {
      const a = code ? p.custom_attributesV2!.items.find((i) => i.code === code) : undefined;
      return a?.selected_options?.map((o) => o.label).join(" ") ?? a?.value ?? undefined;
    };
    const mapped: Partial<PartAttributes> = {};
    const lengthText = label(map.length_mm);
    if (lengthText && /^\d+(\.\d+)?/.test(lengthText)) mapped.length_mm = parseFloat(lengthText);
    const threadText = label(map.thread);
    if (threadText) mapped.thread = parseFastenerText(threadText).thread ?? fromName.thread;
    const gradeText = label(map.grade);
    if (gradeText) mapped.grade = gradeText.trim();
    for (const key of ["material", "finish", "head", "part_type"] as const) {
      const t = label(map[key]);
      if (!t) continue;
      const parsed = attributesFromText(t);
      if (parsed[key] !== null) (mapped as Record<string, unknown>)[key] = parsed[key];
    }
    return { ...fromName, ...mapped };
  }

  private summary(p: GqlPart): ProductSummary {
    return { sku: p.sku, name: p.name ?? p.sku, attributes: this.attributes(p), pack_size: 1, uom: "each" };
  }

  private async visibleParts(skus: string[]): Promise<Map<string, GqlPart>> {
    const unique = [...new Set(skus)];
    const data = await this.gql<{ products: { items: GqlPart[] } }>(Q.productsBySku(this.withAttrs), {
      skus: unique,
      pageSize: unique.length,
    });
    const bySku = new Map(data.products.items.map((p) => [p.sku.toLowerCase(), p]));
    const missing = unique.filter((s) => !bySku.has(s.toLowerCase()));
    if (missing.length) {
      throw new ToolError("NOT_FOUND", `No product with SKU ${missing.map((s) => `"${s}"`).join(", ")} is available to your company.`);
    }
    return bySku;
  }

  async searchParts(caller: Caller, query: SearchQuery): Promise<ProductSummary[]> {
    await this.ensureCaller(caller);
    // Store search engines tokenise "M8x30" unpredictably, so also search by
    // thread alone and let the scorer pick. Results are already limited to the
    // company's shared catalog by Magento.
    const terms = new Set([query.text]);
    if (query.filters.thread) terms.add(query.filters.thread);
    const results = await Promise.all(
      [...terms].map((search) =>
        this.gql<{ products: { items: GqlPart[] } }>(Q.searchProducts(this.withAttrs), { search, pageSize: 40 }),
      ),
    );
    const seen = new Map<string, GqlPart>();
    for (const r of results) for (const p of r.products.items) if (!seen.has(p.sku)) seen.set(p.sku, p);

    // Full-text search can return nothing when the store's search index is broken
    // (seen on a local 2.4.8 copy: a sort on an unmapped field fails every query).
    // Fall back to the name filter, adding the compact size token ("M8x30"), which
    // catalogue names usually spell exactly that way.
    if (seen.size === 0) {
      const { thread, length_mm } = query.filters;
      const nameTerms = new Set([query.text]);
      if (thread && length_mm !== undefined && length_mm !== null) nameTerms.add(`${thread}x${length_mm}`);
      const fallback = await Promise.all(
        [...nameTerms].map((match) =>
          this.gql<{ products: { items: GqlPart[] } }>(Q.searchByName(this.withAttrs), { match, pageSize: 40 }),
        ),
      );
      for (const r of fallback) for (const p of r.products.items) if (!seen.has(p.sku)) seen.set(p.sku, p);
    }
    return [...seen.values()]
      .filter((p) => p.__typename !== "ConfigurableProduct") // parents are not orderable lines
      .map((p) => this.summary(p));
  }

  async getProduct(caller: Caller, sku: string): Promise<ProductDetail> {
    await this.ensureCaller(caller);
    const data = await this.gql<{
      products: { items: Array<GqlPart & { description: { html: string } | null; variants?: Array<{ product: GqlPart | null }> }> };
    }>(Q.productDetail(this.withAttrs), { sku });
    const p = data.products.items.find((i) => i.sku.toLowerCase() === sku.toLowerCase());
    if (!p) throw new ToolError("NOT_FOUND", `No product with SKU "${sku}" is available to your company.`);
    const variants = (p.variants ?? []).flatMap((v) => (v.product ? [this.summary(v.product)] : []));
    return {
      ...this.summary(p),
      description: p.description?.html ?? "",
      type: p.__typename === "ConfigurableProduct" ? "configurable" : "simple",
      variants,
    };
  }

  // ---------------------------------------------------------------- stock

  private async sourceNameMap(token: string): Promise<Map<string, string>> {
    if (!this.sourceNames) {
      const res = await restGet<{ items: Array<{ source_code: string; name: string }> }>(
        this.http,
        "inventory/sources?searchCriteria[pageSize]=200",
        token,
      );
      this.sourceNames = new Map(res.items.map((s) => [s.source_code, s.name]));
    }
    return this.sourceNames;
  }

  async getAvailability(caller: Caller, skus: string[], bySource: boolean): Promise<Availability[]> {
    await this.ensureCaller(caller);
    // Visibility first, as the customer: never reveal stock for a SKU the company can't see.
    const parts = await this.visibleParts(skus);
    const inv = this.opts.inventoryToken;
    const stockId = this.opts.stockId ?? 1;

    return Promise.all(
      skus.map(async (requested): Promise<Availability> => {
        const p = parts.get(requested.toLowerCase())!;
        const storefrontInStock = p.stock_status === "IN_STOCK";
        if (!inv) {
          return {
            sku: p.sku,
            stock_name: null,
            salable_qty: typeof p.quantity === "number" ? p.quantity : null,
            in_stock: storefrontInStock,
            sources: null,
          };
        }

        const sku = encodeURIComponent(p.sku);
        const salable = await restGet<number>(this.http, `inventory/get-product-salable-quantity/${sku}/${stockId}`, inv);
        let sources: SourceStock[] | null = null;
        if (bySource) {
          const names = await this.sourceNameMap(inv);
          const res = await restGet<{ items: Array<{ source_code: string; quantity: number; status: number }> }>(
            this.http,
            `inventory/source-items?searchCriteria[filterGroups][0][filters][0][field]=sku&searchCriteria[filterGroups][0][filters][0][value]=${sku}`,
            inv,
          );
          sources = res.items
            .filter((s) => s.status === 1 && s.quantity > 0)
            .map((s) => ({
              source_code: s.source_code,
              source_name: names.get(s.source_code) ?? s.source_code,
              quantity: s.quantity,
              lead_time_days: this.opts.sourceLeadTimes?.[s.source_code] ?? null,
            }));
        }
        return { sku: p.sku, stock_name: `stock ${stockId}`, salable_qty: salable, in_stock: salable > 0, sources };
      }),
    );
  }

  // ---------------------------------------------------------------- price

  async getCustomerPrices(caller: Caller, lines: Array<{ sku: string; qty: number }>): Promise<CustomerPrice[]> {
    await this.ensureCaller(caller);
    await this.visibleParts(lines.map((l) => l.sku));
    const skus = [...new Set(lines.map((l) => l.sku))];
    const data = await this.gql<{
      products: {
        items: Array<{
          sku: string;
          price_range: { minimum_price: { regular_price: Money; final_price: Money } };
          price_tiers: Array<{ quantity: number | null; final_price: Money | null }> | null;
        }>;
      };
    }>(Q.prices, { skus, pageSize: skus.length });
    const bySku = new Map(data.products.items.map((i) => [i.sku.toLowerCase(), i]));

    return lines.map(({ sku, qty }) => {
      const item = bySku.get(sku.toLowerCase());
      if (!item) throw new ToolError("NOT_FOUND", `No price is available for "${sku}".`);
      const regular = item.price_range.minimum_price.regular_price.value ?? 0;
      const final = item.price_range.minimum_price.final_price.value ?? regular;
      const currency = item.price_range.minimum_price.final_price.currency ?? "";
      const tiers = (item.price_tiers ?? [])
        .filter((t) => t.quantity !== null && t.final_price?.value != null)
        .map((t) => ({ min_qty: t.quantity!, unit_price: t.final_price!.value! }))
        .sort((a, b) => a.min_qty - b.min_qty);
      const tier = [...tiers].reverse().find((t) => qty >= t.min_qty);

      let unit = final;
      let source: CustomerPrice["price_source"] = final < regular ? "customer_price" : "base";
      if (tier && tier.unit_price < unit) {
        unit = tier.unit_price;
        source = "tier";
      }
      return {
        sku: item.sku,
        currency,
        qty,
        base_unit_price: regular,
        unit_price: unit,
        line_total: round2(unit * qty),
        price_source: source,
        tiers,
      };
    });
  }

  // ---------------------------------------------------------------- orders

  private orderSummary(o: GqlOrder): OrderSummary {
    return {
      order_number: o.number,
      created_at: o.order_date,
      status: o.status,
      placed_by: o.email,
      grand_total: o.total?.grand_total.value ?? 0,
      currency: o.total?.grand_total.currency ?? "",
      line_count: o.items?.length ?? 0,
      po_number: null,
    };
  }

  async listOrders(
    caller: Caller,
    opts: { page: number; pageSize: number; status?: OrderStatus },
  ): Promise<Page<OrderSummary>> {
    await this.ensureCaller(caller);
    const data = await this.gql<{ customer: { orders: { total_count: number | null; items: GqlOrder[] } } }>(Q.listOrders, {
      filter: opts.status ? { status: { eq: opts.status } } : null,
      page: opts.page,
      size: opts.pageSize,
    });
    const total = data.customer.orders.total_count ?? 0;
    const items = data.customer.orders.items.map((o) => this.orderSummary(o));
    return { items, page: opts.page, page_size: opts.pageSize, total, has_more: (opts.page - 1) * opts.pageSize + items.length < total };
  }

  async getOrder(caller: Caller, orderNumber: string): Promise<OrderDetail> {
    await this.ensureCaller(caller);
    const data = await this.gql<{ customer: { orders: { items: GqlOrder[] } } }>(Q.orderDetail, { number: orderNumber });
    const o = data.customer.orders.items.find((x) => x.number === orderNumber);
    if (!o) throw new ToolError("NOT_FOUND", `Order ${orderNumber} was not found for your company.`);
    return {
      ...this.orderSummary(o),
      lines: (o.items ?? []).map((i) => ({
        sku: i.product_sku,
        name: i.product_name ?? i.product_sku,
        qty_ordered: i.quantity_ordered ?? 0,
        qty_shipped: i.quantity_shipped ?? 0,
        row_total: round2((i.product_sale_price?.value ?? 0) * (i.quantity_ordered ?? 0)),
      })),
      shipments: (o.shipments ?? []).flatMap((s) =>
        (s.tracking ?? []).map((t) => ({ tracking_number: t.number ?? "", carrier: t.title || t.carrier, shipped_at: null })),
      ),
    };
  }

  // ---------------------------------------------------------------- requisition lists

  async listRequisitionLists(caller: Caller): Promise<RequisitionListSummary[]> {
    await this.ensureCaller(caller);
    const data = await this.gql<{
      customer: { requisition_lists: { items: Array<{ uid: string; name: string; items_count: number; updated_at: string | null }> } | null };
    }>(Q.requisitionLists);
    return (data.customer.requisition_lists?.items ?? []).map((l) => ({
      id: l.uid,
      name: l.name,
      item_count: l.items_count,
      updated_at: l.updated_at,
    }));
  }

  async getRequisitionList(caller: Caller, id: string): Promise<RequisitionList> {
    await this.ensureCaller(caller);
    const data = await this.gql<{
      customer: {
        requisition_lists: {
          items: Array<{
            uid: string;
            name: string;
            description: string | null;
            items_count: number;
            updated_at: string | null;
            list_items: { items: Array<{ quantity: number; product: { sku: string } }> } | null;
          }>;
        } | null;
      };
    }>(Q.requisitionList, { uid: id });
    const l = data.customer.requisition_lists?.items.find((x) => x.uid === id);
    if (!l) throw new ToolError("NOT_FOUND", `Requisition list ${id} was not found.`);
    return {
      id: l.uid,
      name: l.name,
      description: l.description,
      item_count: l.items_count,
      updated_at: l.updated_at,
      items: (l.list_items?.items ?? []).map((i) => ({ sku: i.product.sku, qty: i.quantity })),
    };
  }

  // ---------------------------------------------------------------- quotes

  /** Best effort: deactivate the quote's cart so Magento reactivates the buyer's previous cart. */
  private async restoreBuyerCart(cartId: string): Promise<void> {
    try {
      await this.gql(Q.setCartAsInactive, { cartId });
    } catch (err) {
      process.stderr.write(`[commerce-b2b-mcp] WARNING could not restore the buyer's cart after a failed draft: ${String(err)}\n`);
    }
  }

  async createDraftQuote(caller: Caller, input: QuoteDraftInput): Promise<QuoteDraft> {
    await this.ensureCaller(caller);
    // A brand-new cart, so the buyer's open shopping cart is never pulled into the quote.
    // Magento makes the new cart the active one; requesting the quote hands the buyer's
    // previous cart back. If anything fails in between, deactivating the new cart does
    // the same (verified on 2.4.8 / B2B 1.5.2), so the buyer never loses their cart.
    const added = await this.gql<{
      addProductsToNewCart: { cart: { id: string } | null; user_errors: Array<{ code: string; message: string }> | null };
    }>(Q.addProductsToNewCart, { items: input.lines.map((l) => ({ sku: l.sku, quantity: l.qty })) });
    const errs = added.addProductsToNewCart.user_errors ?? [];
    const cart = added.addProductsToNewCart.cart;
    if (errs.length || !cart) {
      if (cart) await this.restoreBuyerCart(cart.id);
      throw new ToolError(
        "INVALID_INPUT",
        `The store could not add these lines: ${errs.map((e) => e.message.slice(0, 200)).join("; ") || "no cart returned"}`,
      );
    }

    type DraftResponse = {
      requestNegotiableQuote: {
        quote: {
          uid: string;
          name: string;
          status: string;
          created_at: string | null;
          items: Array<{
            uid: string;
            quantity: number;
            product: { sku: string; name: string | null };
            prices: { price: Money; row_total: Money } | null;
          }> | null;
          prices: { subtotal_excluding_tax: Money } | null;
        } | null;
      };
    };
    let res: DraftResponse;
    try {
      res = await this.gql<DraftResponse>(Q.requestDraftQuote, {
        input: {
          cart_id: cart.id,
          quote_name: input.name,
          comment: { comment: input.comment ?? "Drafted by an AI assistant for review." },
          is_draft: true,
        },
      });
    } catch (err) {
      await this.restoreBuyerCart(cart.id);
      throw err;
    }
    const quote = res.requestNegotiableQuote.quote;
    if (!quote) {
      await this.restoreBuyerCart(cart.id);
      throw new ToolError("INTERNAL", "The store did not return the draft quote.");
    }
    if (quote.status !== "DRAFT") {
      // Older B2B versions ignore is_draft and submit. Report it; never call it a draft.
      process.stderr.write(`[commerce-b2b-mcp] WARNING quote ${quote.uid} has status ${quote.status}, expected DRAFT\n`);
    }

    const items = quote.items ?? [];
    const notes = input.lines.filter((l) => l.note);
    for (const l of notes) {
      const item = items.find((i) => i.product.sku.toLowerCase() === l.sku.toLowerCase());
      if (item) {
        await this.gql(Q.setLineItemNote, { input: { quote_uid: quote.uid, quote_item_uid: item.uid, note: l.note } });
      }
    }

    const lines = items.map((i) => {
      const requested = input.lines.find((l) => l.sku.toLowerCase() === i.product.sku.toLowerCase());
      return {
        sku: i.product.sku,
        name: i.product.name ?? i.product.sku,
        qty: i.quantity,
        unit_price: i.prices?.price.value ?? 0,
        row_total: round2(i.prices?.row_total.value ?? 0),
        note: requested?.note ?? null,
      };
    });
    return {
      quote_id: quote.uid,
      name: quote.name,
      status: quote.status.toLowerCase(),
      review_url: this.opts.quoteReviewUrl ?? null,
      currency: quote.prices?.subtotal_excluding_tax.currency ?? items[0]?.prices?.price.currency ?? "",
      lines,
      subtotal: round2(quote.prices?.subtotal_excluding_tax.value ?? round2(lines.reduce((s, l) => s + l.row_total, 0))),
      created_at: quote.created_at ?? new Date().toISOString(),
    };
  }
}
