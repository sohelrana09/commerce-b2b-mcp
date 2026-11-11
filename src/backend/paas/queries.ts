/**
 * GraphQL documents for Adobe Commerce 2.4.7+ with B2B, checked against the
 * published 2.4.9 schema. All of them run with the company user's customer
 * token, so Magento applies shared catalog visibility, customer-group and
 * tier pricing, and company permissions itself.
 */

export function partFields(withCustomAttributes: boolean): string {
  return `
    uid sku name __typename
    stock_status only_x_left_in_stock quantity
    ${
      withCustomAttributes
        ? `custom_attributesV2 { items { code
            ... on AttributeValue { value }
            ... on AttributeSelectedOptions { selected_options { label } } } }`
        : ""
    }`;
}

export const searchProducts = (attrs: boolean) => `
  query SearchParts($search: String!, $pageSize: Int!) {
    products(search: $search, pageSize: $pageSize) { items { ${partFields(attrs)} } }
  }`;

/** Fallback when full-text search is broken or empty: relevance-ranked name match. */
export const searchByName = (attrs: boolean) => `
  query SearchPartsByName($match: String!, $pageSize: Int!) {
    products(filter: { name: { match: $match } }, pageSize: $pageSize) { items { ${partFields(attrs)} } }
  }`;

export const productsBySku = (attrs: boolean) => `
  query PartsBySku($skus: [String!]!, $pageSize: Int!) {
    products(filter: { sku: { in: $skus } }, pageSize: $pageSize) { items { ${partFields(attrs)} } }
  }`;

export const productDetail = (attrs: boolean) => `
  query PartDetail($sku: String!) {
    products(filter: { sku: { eq: $sku } }) {
      items {
        ${partFields(attrs)}
        description { html }
        ... on ConfigurableProduct { variants { product { ${partFields(attrs)} } } }
      }
    }
  }`;

export const prices = `
  query CustomerPrices($skus: [String!]!, $pageSize: Int!) {
    products(filter: { sku: { in: $skus } }, pageSize: $pageSize) {
      items {
        sku
        price_range { minimum_price {
          regular_price { value currency }
          final_price { value currency }
        } }
        price_tiers { quantity final_price { value currency } }
      }
    }
  }`;

const aclLevel = (depth: number): string => (depth === 0 ? "id" : `id children { ${aclLevel(depth - 1)} }`);

export const companyContext = `
  query CompanyContext {
    customer {
      email firstname lastname job_title status
      role { name permissions { ${aclLevel(4)} } }
    }
    company {
      id name
      company_admin { email }
      payment_methods
      sales_representative { firstname lastname email }
    }
  }`;

export const companyCredit = `
  query CompanyCredit {
    company { credit {
      available_credit { value currency }
      credit_limit { value currency }
      outstanding_balance { value currency }
    } }
  }`;

const orderSummaryFields = `
  number order_date status email
  total { grand_total { value currency } }
  items { product_sku }`;

export const listOrders = `
  query ListOrders($filter: CustomerOrdersFilterInput, $page: Int!, $size: Int!) {
    customer {
      orders(filter: $filter, currentPage: $page, pageSize: $size, sort: { sort_field: CREATED_AT, sort_direction: DESC }) {
        total_count
        items { ${orderSummaryFields} }
      }
    }
  }`;

export const orderDetail = `
  query OrderDetail($number: String!) {
    customer {
      orders(filter: { number: { eq: $number } }, pageSize: 1) {
        items {
          ${orderSummaryFields}
          items { product_sku product_name quantity_ordered quantity_shipped product_sale_price { value } }
          shipments { tracking { carrier number title } }
        }
      }
    }
  }`;

export const requisitionLists = `
  query RequisitionLists {
    customer { requisition_lists(pageSize: 50) { items { uid name items_count updated_at } } }
  }`;

export const requisitionList = `
  query RequisitionList($uid: String!) {
    customer {
      requisition_lists(filter: { uids: { eq: $uid } }) {
        items {
          uid name description items_count updated_at
          # items works on 2.4.7-2.4.9; requisition_list_items is 2.4.9+ only.
          list_items: items(pageSize: 200) { items { quantity product { sku } } }
        }
      }
    }
  }`;

export const addProductsToNewCart = `
  mutation NewQuoteCart($items: [CartItemInput!]!) {
    addProductsToNewCart(cartItems: $items) {
      cart { id items { uid quantity product { sku } } }
      user_errors { code message }
    }
  }`;

export const requestDraftQuote = `
  mutation DraftQuote($input: RequestNegotiableQuoteInput!) {
    requestNegotiableQuote(input: $input) {
      quote {
        uid name status created_at
        items { uid quantity product { sku name } prices { price { value currency } row_total { value currency } } }
        prices { subtotal_excluding_tax { value currency } }
      }
    }
  }`;

export const setLineItemNote = `
  mutation LineNote($input: LineItemNoteInput!) {
    setLineItemNote(input: $input) { quote { uid } }
  }`;

export const setCartAsInactive = `
  mutation RestoreCart($cartId: String!) {
    setCartAsInactive(cartId: $cartId) { success error }
  }`;
