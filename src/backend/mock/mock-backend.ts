import { ToolError } from "../../errors.js";
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
  ProductDetail,
  ProductSummary,
  QuoteDraft,
  QuoteDraftInput,
  RequisitionList,
  RequisitionListSummary,
  SearchQuery,
} from "../types.js";
import * as F from "./fixtures.js";

interface Resolved {
  user: F.FixtureUser;
  company: F.FixtureCompany;
  catalog: F.FixtureSharedCatalog;
}

const CURRENCY = "GBP";
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * In-memory backend that behaves like Adobe Commerce B2B for the purposes of
 * the demo: shared catalogs control visibility and price, MSI computes
 * salable qty from sources minus reservations, and every read is scoped to
 * the caller's company and B2B permissions.
 */
export class MockBackend implements CommerceBackend {
  readonly name = "mock";
  private quotes: Array<QuoteDraft & { company_id: string }> = [];
  private quoteSeq = 5001;

  constructor(private readonly now: () => Date = () => new Date()) {}

  private resolve(caller: Caller): Resolved {
    const user = F.USERS.find((u) => u.email.toLowerCase() === caller.email.toLowerCase());
    if (!user) throw new ToolError("FORBIDDEN", "The configured caller is not a company user on this store.");
    const company = F.COMPANIES.find((c) => c.id === user.company_id);
    const catalog = F.SHARED_CATALOGS.find((s) => s.id === company?.shared_catalog_id);
    if (!company || !catalog) throw new ToolError("INTERNAL", "Company configuration is incomplete.");
    return { user, company, catalog };
  }

  private require(r: Resolved, permission: B2BPermission): void {
    if (!r.user.permissions.includes(permission)) {
      throw new ToolError(
        "FORBIDDEN",
        `Your company role does not allow this action (${permission}).`,
        "Ask your company admin to grant the permission, or ask a colleague who has it.",
      );
    }
  }

  /** Products outside the company's shared catalog do not exist for this caller. */
  private visible(r: Resolved, sku: string): F.FixtureProduct {
    const p = F.PRODUCTS.find((x) => x.sku.toLowerCase() === sku.toLowerCase());
    if (!p || !(p.sku in r.catalog.prices)) {
      throw new ToolError("NOT_FOUND", `No product with SKU "${sku}" is available to your company.`);
    }
    return p;
  }

  private summary(p: F.FixtureProduct): ProductSummary {
    return { sku: p.sku, name: p.name, attributes: p.attributes, pack_size: p.pack_size, uom: p.uom };
  }

  async getCompanyContext(caller: Caller): Promise<CompanyContext> {
    const r = this.resolve(caller);
    const canSeeCredit = r.user.permissions.includes("company.view_credit");
    const c = r.company.credit;
    return {
      company_id: r.company.id,
      company_name: r.company.name,
      user: { email: r.user.email, name: r.user.name, role: r.user.role, job_title: r.user.job_title },
      customer_group: r.company.customer_group,
      shared_catalog: r.catalog.name,
      permissions: r.user.permissions,
      credit:
        c && canSeeCredit
          ? {
              currency: c.currency,
              limit: c.limit,
              outstanding_balance: c.outstanding_balance,
              available: round2(c.limit - c.outstanding_balance),
              exceed_limit_allowed: c.exceed_limit_allowed,
            }
          : null,
      payment_on_account_enabled: r.company.payment_on_account_enabled,
      sales_rep: r.company.sales_rep,
    };
  }

  async searchParts(caller: Caller, query: SearchQuery): Promise<ProductSummary[]> {
    const r = this.resolve(caller);
    this.require(r, "catalog.view");
    const f = query.filters;
    const words = query.text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

    return F.PRODUCTS.filter((p) => p.sku in r.catalog.prices)
      .filter((p) => (f.thread ? p.attributes.thread === f.thread : true))
      .filter((p) => (f.length_mm !== undefined ? p.attributes.length_mm === f.length_mm : true))
      .filter((p) => {
        // With no structured size, fall back to a loose name/sku text match.
        if (f.thread || f.length_mm !== undefined || f.part_type) return true;
        const hay = `${p.sku} ${p.name}`.toLowerCase();
        return words.length === 0 || words.some((w) => hay.includes(w));
      })
      .map((p) => this.summary(p));
  }

  async getProduct(caller: Caller, sku: string): Promise<ProductDetail> {
    const r = this.resolve(caller);
    this.require(r, "catalog.view");
    const p = this.visible(r, sku);
    const variants = F.PRODUCTS.filter((x) => x.parent_sku === p.sku && x.sku in r.catalog.prices).map((x) => this.summary(x));
    return { ...this.summary(p), description: p.description, type: variants.length ? "configurable" : "simple", variants };
  }

  async getAvailability(caller: Caller, skus: string[], bySource: boolean): Promise<Availability[]> {
    const r = this.resolve(caller);
    this.require(r, "catalog.view");
    return skus.map((sku) => {
      const p = this.visible(r, sku);
      const sources = F.SOURCES.map((s) => ({
        source_code: s.code,
        source_name: s.name,
        quantity: F.SOURCE_ITEMS[s.code]?.[p.sku] ?? 0,
        lead_time_days: s.lead_time_days,
      })).filter((s) => s.quantity > 0);
      const onHand = sources.reduce((sum, s) => sum + s.quantity, 0);
      const salable = Math.max(0, onHand - (F.RESERVATIONS[p.sku] ?? 0));
      return {
        sku: p.sku,
        stock_name: r.company.stock_id,
        salable_qty: salable,
        in_stock: salable > 0,
        sources: bySource ? sources : null,
      };
    });
  }

  async getCustomerPrices(caller: Caller, lines: Array<{ sku: string; qty: number }>): Promise<CustomerPrice[]> {
    const r = this.resolve(caller);
    this.require(r, "catalog.view");
    return lines.map(({ sku, qty }) => {
      const p = this.visible(r, sku);
      const negotiated = r.catalog.prices[p.sku] ?? null;
      const tier = [...p.tiers].reverse().find((t) => qty >= t.min_qty);

      // Magento picks the lowest applicable price.
      let unit = p.base_price;
      let source: CustomerPrice["price_source"] = "base";
      if (tier && tier.unit_price < unit) {
        unit = tier.unit_price;
        source = "tier";
      }
      if (negotiated !== null && negotiated < unit) {
        unit = negotiated;
        source = "shared_catalog";
      }
      return {
        sku: p.sku,
        currency: CURRENCY,
        qty,
        base_unit_price: p.base_price,
        unit_price: unit,
        line_total: round2(unit * qty),
        price_source: source,
        tiers: p.tiers,
      };
    });
  }

  private ordersFor(r: Resolved) {
    const all = r.user.permissions.includes("orders.view_all");
    if (!all) this.require(r, "orders.view_own");
    return F.ORDERS.filter((o) => o.company_id === r.company.id && (all || o.placed_by === r.user.email));
  }

  async listOrders(
    caller: Caller,
    opts: { page: number; pageSize: number; status?: OrderStatus },
  ): Promise<Page<OrderSummary>> {
    const r = this.resolve(caller);
    const rows = this.ordersFor(r)
      .filter((o) => (opts.status ? o.status === opts.status : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const start = (opts.page - 1) * opts.pageSize;
    const items = rows.slice(start, start + opts.pageSize).map(
      ({ order_number, created_at, status, placed_by, grand_total, currency, line_count, po_number }) => ({
        order_number,
        created_at,
        status,
        placed_by,
        grand_total,
        currency,
        line_count,
        po_number,
      }),
    );
    return { items, page: opts.page, page_size: opts.pageSize, total: rows.length, has_more: start + items.length < rows.length };
  }

  async getOrder(caller: Caller, orderNumber: string): Promise<OrderDetail> {
    const r = this.resolve(caller);
    // Same NOT_FOUND for "doesn't exist" and "belongs to someone else": no existence leak.
    const o = this.ordersFor(r).find((x) => x.order_number === orderNumber);
    if (!o) throw new ToolError("NOT_FOUND", `Order ${orderNumber} was not found for your company.`);
    const { company_id: _c, ...detail } = o;
    return detail;
  }

  private listsFor(r: Resolved) {
    this.require(r, "requisition_lists.view");
    return F.REQUISITION_LISTS.filter((l) => l.company_id === r.company.id && l.owner === r.user.email);
  }

  async listRequisitionLists(caller: Caller): Promise<RequisitionListSummary[]> {
    const r = this.resolve(caller);
    return this.listsFor(r).map(({ id, name, item_count, updated_at }) => ({ id, name, item_count, updated_at }));
  }

  async getRequisitionList(caller: Caller, id: string): Promise<RequisitionList> {
    const r = this.resolve(caller);
    const l = this.listsFor(r).find((x) => x.id === id);
    if (!l) throw new ToolError("NOT_FOUND", `Requisition list ${id} was not found.`);
    const { company_id: _c, owner: _o, ...list } = l;
    return list;
  }

  async createDraftQuote(caller: Caller, input: QuoteDraftInput): Promise<QuoteDraft> {
    const r = this.resolve(caller);
    this.require(r, "quotes.create");
    const prices = await this.getCustomerPrices(caller, input.lines);
    const lines = input.lines.map((l, i) => {
      const p = this.visible(r, l.sku);
      const price = prices[i]!;
      return { sku: p.sku, name: p.name, qty: l.qty, unit_price: price.unit_price, row_total: price.line_total, note: l.note ?? null };
    });
    const quote: QuoteDraft & { company_id: string } = {
      company_id: r.company.id,
      quote_id: `Q-${this.quoteSeq++}`,
      name: input.name,
      status: "draft",
      review_url: null,
      currency: CURRENCY,
      lines,
      subtotal: round2(lines.reduce((s, l) => s + l.row_total, 0)),
      created_at: this.now().toISOString(),
    };
    this.quotes.push(quote);
    const { company_id: _c, ...out } = quote;
    return out;
  }
}
