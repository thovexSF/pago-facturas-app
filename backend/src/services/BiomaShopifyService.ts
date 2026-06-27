/**
 * BiomaShopifyService — thin wrapper around the Shopify Admin GraphQL API,
 * authenticated with a Dev Dashboard app via `client_credentials` grant.
 *
 * Required env vars:
 *   - BIOMA_SHOPIFY_SHOP or BIOMA_SHOPIFY_STORE_DOMAIN  (e.g. biomacoffee.myshopify.com)
 *   - BIOMA_SHOPIFY_API_CLIENT_ID
 *   - BIOMA_SHOPIFY_API_CLIENT_SECRET
 *
 * Optional:
 *   - BIOMA_SHOPIFY_API_VERSION    (defaults to 2025-10)
 *   - BIOMA_FACTURA_TAG            (defaults to 'factura')
 *
 * Scopes Admin API: read_orders, write_orders, read_customers, read_all_orders,
 * read_products (variant.sku y selectedOptions en líneas — opcional con fallback).
 */

import axios from 'axios';
import {
  BIOMA_FACTURA_ATTR,
  boletaEmitidaTag,
  facturaEmitidaTag,
  getOrderCustomAttribute,
  orderHasEmitidoShopifyTag,
  orderHasFacturaPendienteTag,
  orderWantsFacturaEmit,
  extractFacturaFieldsFromOrder,
} from '../utils/biomaOrderAttrs';

const DEFAULT_API_VERSION = '2025-10';
export const DEFAULT_FACTURA_TAG = 'factura';
/** Tag fijo al emitir DTE (reemplaza `factura`). Alineado con Shopify Flow. */
export const FACTURA_EMITIDA_TAG = 'facturado';
export const DEFAULT_BOLETA_TAG = 'boleta';
export const BOLETA_EMITIDA_TAG = 'boletado';

interface TokenCache {
  token: string;
  expiresAt: number;
  scope: string;
}

export interface ShopifyOrderAttribute {
  key: string;
  value: string;
}

export interface ShopifyVariantOption {
  name: string;
  value: string;
}

export interface ShopifyOrderLineItem {
  /** Nombre completo de la línea en Shopify (título + variante). */
  name: string;
  title: string;
  variantTitle: string | null;
  variantOptions: ShopifyVariantOption[];
  sku: string | null;
  quantity: number;
  originalUnitPriceAmount: number;
  totalDiscountAmount: number;
  netSubtotal: number;
}

export interface ShopifyOrderShippingAddress {
  name: string | null;
  phone: string | null;
  address1: string | null;
  city: string | null;
  province: string | null;
  zip: string | null;
  country: string | null;
}

export interface ShopifyOrderForBioma {
  id: string; // gid://shopify/Order/...
  name: string; // "#3549"
  note: string | null;
  orderNumber: number | null;
  processedAt: string;
  displayFinancialStatus: string;
  tags: string[];
  customAttributes: ShopifyOrderAttribute[];
  customerNote: string | null;
  customer: {
    id: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    note: string | null;
  } | null;
  shippingAddress: ShopifyOrderShippingAddress | null;
  totalNet: number;
  totalTax: number;
  total: number;
  shippingTotal: number;
  totalDiscounts: number;
  currencyCode: string;
  lineItems: ShopifyOrderLineItem[];
}

export interface ListPendingOptions {
  /** Tag to look for. Default: 'factura'. */
  tag?: string;
  /** Exclusion tag (orders already emitted). Fixed: `facturado`. */
  excludeTag?: string;
  /** Maximum number of orders to return per page. Default 50, max 250. */
  pageSize?: number;
  /** Pagination cursor. */
  after?: string | null;
  /** Only include paid orders. Default true. */
  paidOnly?: boolean;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const ORDERS_QUERY = `#graphql
  query BiomaPending($cursor: String, $query: String!, $first: Int!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          note
          processedAt
          displayFinancialStatus
          tags
          customAttributes { key value }
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            phone
            note
          }
          shippingAddress {
            name
            phone
            address1
            city
            province
            zip
            country
          }
          currentSubtotalPriceSet { shopMoney { amount } }
          currentTotalTaxSet { shopMoney { amount } }
          currentTotalDiscountsSet { shopMoney { amount } }
          currentShippingPriceSet { shopMoney { amount } }
          currentTotalPriceSet { shopMoney { amount } }
          lineItems(first: 50) {
            edges {
              node {
                name
                title
                variantTitle
                variant {
                  sku
                  selectedOptions {
                    name
                    value
                  }
                }
                quantity
                originalUnitPriceSet { shopMoney { amount } }
                totalDiscountSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

/** Sin `variant { }` — no requiere scope read_products. */
const ORDERS_QUERY_LITE = `#graphql
  query BiomaPendingLite($cursor: String, $query: String!, $first: Int!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          note
          processedAt
          displayFinancialStatus
          tags
          customAttributes { key value }
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            phone
            note
          }
          shippingAddress {
            name
            phone
            address1
            city
            province
            zip
            country
          }
          currentSubtotalPriceSet { shopMoney { amount } }
          currentTotalTaxSet { shopMoney { amount } }
          currentTotalDiscountsSet { shopMoney { amount } }
          currentShippingPriceSet { shopMoney { amount } }
          currentTotalPriceSet { shopMoney { amount } }
          lineItems(first: 50) {
            edges {
              node {
                name
                title
                variantTitle
                quantity
                originalUnitPriceSet { shopMoney { amount } }
                totalDiscountSet { shopMoney { amount } }
                discountedTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

const DRAFT_ORDERS_QUERY = `#graphql
  query BiomaDraftPending($cursor: String, $query: String!, $first: Int!) {
    draftOrders(first: $first, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          note
          createdAt
          status
          tags
          customAttributes { key value }
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            phone
            note
          }
          shippingAddress {
            name
            phone
            address1
            city
            province
            zip
            country
          }
          subtotalPrice
          totalTax
          totalPrice
          lineItems(first: 50) {
            edges {
              node {
                name
                title
                variantTitle
                variant {
                  sku
                  selectedOptions {
                    name
                    value
                  }
                }
                quantity
                originalUnitPrice
                totalDiscount
                discountedTotal
              }
            }
          }
        }
      }
    }
  }
`;

const DRAFT_ORDERS_QUERY_LITE = `#graphql
  query BiomaDraftPendingLite($cursor: String, $query: String!, $first: Int!) {
    draftOrders(first: $first, after: $cursor, query: $query, sortKey: UPDATED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          note
          createdAt
          status
          tags
          customAttributes { key value }
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            phone
            note
          }
          shippingAddress {
            name
            phone
            address1
            city
            province
            zip
            country
          }
          subtotalPrice
          totalTax
          totalPrice
          lineItems(first: 50) {
            edges {
              node {
                name
                title
                variantTitle
                quantity
                originalUnitPrice
                totalDiscount
                discountedTotal
              }
            }
          }
        }
      }
    }
  }
`;

function mapDraftOrderNode(node: any): ShopifyOrderForBioma {
  const lineItems: ShopifyOrderLineItem[] =
    node?.lineItems?.edges?.map((edge: any) => mapLineItemFromDraftNode(edge)) ?? [];

  const orderNumberMatch = node?.name?.match(/#?D?(\d+)/);
  const orderNumber = orderNumberMatch ? parseInt(orderNumberMatch[1], 10) : null;

  return {
    id: node.id,
    name: node.name,
    note: node.note ?? null,
    orderNumber,
    processedAt: node.createdAt,
    displayFinancialStatus: node.status === 'COMPLETED' ? 'PAID' : 'PENDING',
    tags: node.tags ?? [],
    customAttributes: node.customAttributes ?? [],
    customerNote: node.customer?.note ?? null,
    customer: node.customer
      ? {
          id: node.customer.id ?? null,
          email: node.customer.email ?? null,
          firstName: node.customer.firstName ?? null,
          lastName: node.customer.lastName ?? null,
          phone: node.customer.phone ?? null,
          note: node.customer.note ?? null,
        }
      : null,
    shippingAddress: node.shippingAddress
      ? {
          name: node.shippingAddress.name ?? null,
          phone: node.shippingAddress.phone ?? null,
          address1: node.shippingAddress.address1 ?? null,
          city: node.shippingAddress.city ?? null,
          province: node.shippingAddress.province ?? null,
          zip: node.shippingAddress.zip ?? null,
          country: node.shippingAddress.country ?? null,
        }
      : null,
    totalNet: num(node?.subtotalPrice),
    totalTax: num(node?.totalTax),
    total: num(node?.totalPrice),
    shippingTotal: Math.max(
      0,
      num(node?.totalPrice) - num(node?.subtotalPrice) - num(node?.totalTax),
    ),
    totalDiscounts: lineItems.reduce((sum, li) => sum + li.totalDiscountAmount, 0),
    currencyCode: node?.currencyCode ?? 'CLP',
    lineItems,
  };
}

const TAGS_ADD_MUTATION = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = `#graphql
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

const ORDER_FETCH_QUERY = `#graphql
  query OrderById($id: ID!) {
    order(id: $id) {
      id
      name
      note
      processedAt
      displayFinancialStatus
      tags
      customAttributes { key value }
      currencyCode
      customer {
        id
        email
        firstName
        lastName
        phone
        note
      }
      shippingAddress {
        name
        phone
        address1
        city
        province
        zip
        country
      }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      lineItems(first: 50) {
        edges {
          node {
            name
            title
            variantTitle
            variant {
              sku
              selectedOptions {
                name
                value
              }
            }
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const ORDER_FETCH_QUERY_LITE = `#graphql
  query OrderByIdLite($id: ID!) {
    order(id: $id) {
      id
      name
      note
      processedAt
      displayFinancialStatus
      tags
      customAttributes { key value }
      currencyCode
      customer {
        id
        email
        firstName
        lastName
        phone
        note
      }
      shippingAddress {
        name
        phone
        address1
        city
        province
        zip
        country
      }
      currentSubtotalPriceSet { shopMoney { amount } }
      currentTotalTaxSet { shopMoney { amount } }
      currentTotalDiscountsSet { shopMoney { amount } }
      currentShippingPriceSet { shopMoney { amount } }
      currentTotalPriceSet { shopMoney { amount } }
      lineItems(first: 50) {
        edges {
          node {
            name
            title
            variantTitle
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
            discountedTotalSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapVariantOptions(node: any): ShopifyVariantOption[] {
  const opts = node?.variant?.selectedOptions ?? [];
  if (opts.length) {
    return opts.map((o: any) => ({
      name: String(o?.name ?? ''),
      value: String(o?.value ?? ''),
    }));
  }
  return inferVariantOptionsFromLine(
    String(node?.name ?? node?.title ?? ''),
    node?.variantTitle ?? null,
  );
}

/** Aproxima opciones (p. ej. Tamaño) desde name/variantTitle cuando falta read_products. */
function inferVariantOptionsFromLine(
  name: string,
  variantTitle: string | null,
): ShopifyVariantOption[] {
  const out: ShopifyVariantOption[] = [];
  const v = (variantTitle || '').trim();
  if (v && !/^default\s+title$/i.test(v)) {
    out.push({ name: 'Variant', value: v });
    if (/\d+\s*(kg|gr?|ml|lt?|l)\b/i.test(v)) {
      out.push({ name: 'Tamaño', value: v });
    }
  }
  const dashIdx = name.indexOf(' - ');
  if (dashIdx >= 0) {
    const tail = name.slice(dashIdx + 3);
    for (const seg of tail.split('/')) {
      const s = seg.trim();
      if (!s) continue;
      if (!out.some((o) => o.value === s)) {
        out.push({ name: 'Opción', value: s });
      }
      if (/\d+\s*(kg|gr?|ml|lt?|l)\b/i.test(s) && !out.some((o) => o.name === 'Tamaño')) {
        out.push({ name: 'Tamaño', value: s });
      }
    }
  }
  return out;
}

function mapLineItemFromDraftNode(edge: any): ShopifyOrderLineItem {
  return {
    name: edge.node?.name ?? edge.node?.title ?? '',
    title: edge.node?.title ?? '',
    variantTitle: edge.node?.variantTitle ?? null,
    variantOptions: mapVariantOptions(edge.node),
    sku: edge.node?.variant?.sku ?? null,
    quantity: num(edge.node?.quantity),
    originalUnitPriceAmount: num(edge.node?.originalUnitPrice),
    totalDiscountAmount: num(edge.node?.totalDiscount),
    netSubtotal: num(edge.node?.discountedTotal),
  };
}

function mapLineItemFromOrderNode(edge: any): ShopifyOrderLineItem {
  return {
    name: edge.node?.name ?? edge.node?.title ?? '',
    title: edge.node?.title ?? '',
    variantTitle: edge.node?.variantTitle ?? null,
    variantOptions: mapVariantOptions(edge.node),
    sku: edge.node?.variant?.sku ?? null,
    quantity: num(edge.node?.quantity),
    originalUnitPriceAmount: num(edge.node?.originalUnitPriceSet?.shopMoney?.amount),
    totalDiscountAmount: num(edge.node?.totalDiscountSet?.shopMoney?.amount),
    netSubtotal: num(edge.node?.discountedTotalSet?.shopMoney?.amount),
  };
}

function mapOrderNode(node: any): ShopifyOrderForBioma {
  const lineItems: ShopifyOrderLineItem[] =
    node?.lineItems?.edges?.map((edge: any) => mapLineItemFromOrderNode(edge)) ?? [];

  const orderNumberMatch = node?.name?.match(/#(\d+)/);
  const orderNumber = orderNumberMatch ? parseInt(orderNumberMatch[1], 10) : null;

  return {
    id: node.id,
    name: node.name,
    note: node.note ?? null,
    orderNumber,
    processedAt: node.processedAt,
    displayFinancialStatus: node.displayFinancialStatus,
    tags: node.tags ?? [],
    customAttributes: node.customAttributes ?? [],
    customerNote: node.customer?.note ?? null,
    customer: node.customer
      ? {
          id: node.customer.id ?? null,
          email: node.customer.email ?? null,
          firstName: node.customer.firstName ?? null,
          lastName: node.customer.lastName ?? null,
          phone: node.customer.phone ?? null,
          note: node.customer.note ?? null,
        }
      : null,
    shippingAddress: node.shippingAddress
      ? {
          name: node.shippingAddress.name ?? null,
          phone: node.shippingAddress.phone ?? null,
          address1: node.shippingAddress.address1 ?? null,
          city: node.shippingAddress.city ?? null,
          province: node.shippingAddress.province ?? null,
          zip: node.shippingAddress.zip ?? null,
          country: node.shippingAddress.country ?? null,
        }
      : null,
    totalNet: num(node?.currentSubtotalPriceSet?.shopMoney?.amount),
    totalTax: num(node?.currentTotalTaxSet?.shopMoney?.amount),
    total: num(node?.currentTotalPriceSet?.shopMoney?.amount),
    shippingTotal: num(node?.currentShippingPriceSet?.shopMoney?.amount),
    totalDiscounts: num(node?.currentTotalDiscountsSet?.shopMoney?.amount),
    currencyCode: node?.currencyCode ?? 'CLP',
    lineItems,
  };
}

export class BiomaShopifyService {
  private static tokenCache: TokenCache | null = null;
  /** null = aún no probado; false = falta read_products (usar query lite). */
  private static variantFieldsAvailable: boolean | null = null;

  private static get storeDomain(): string {
    const v = process.env.BIOMA_SHOPIFY_SHOP || process.env.BIOMA_SHOPIFY_STORE_DOMAIN;
    if (!v) throw new Error('BIOMA_SHOPIFY_SHOP no configurado');
    return v;
  }

  private static get clientId(): string {
    const v = process.env.BIOMA_SHOPIFY_API_CLIENT_ID || process.env.BIOMA_SHOPIFY_CLIENT_ID;
    if (!v) throw new Error('BIOMA_SHOPIFY_API_CLIENT_ID no configurado');
    return v;
  }

  private static get clientSecret(): string {
    const v = process.env.BIOMA_SHOPIFY_API_CLIENT_SECRET || process.env.BIOMA_SHOPIFY_CLIENT_SECRET;
    if (!v) throw new Error('BIOMA_SHOPIFY_API_CLIENT_SECRET no configurado');
    return v;
  }

  private static get apiVersion(): string {
    return process.env.BIOMA_SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
  }

  static get facturaTag(): string {
    return process.env.BIOMA_FACTURA_TAG || DEFAULT_FACTURA_TAG;
  }

  static get facturaEmitidaTag(): string {
    return FACTURA_EMITIDA_TAG;
  }

  /** Returns a cached access token if still valid (with 60s safety margin). */
  private static async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt > now + 60_000) {
      return this.tokenCache.token;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const url = `https://${this.storeDomain}/admin/oauth/access_token`;
    const res = await axios.post(url, body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data?.access_token) {
      throw new Error(
        `Shopify token exchange failed (${res.status}): ${typeof res.data === 'string' ? res.data : JSON.stringify(res.data)}`,
      );
    }
    const expiresInSec = num(res.data.expires_in) || 3600;
    const scope = String(res.data.scope || '');
    this.tokenCache = {
      token: res.data.access_token,
      scope,
      expiresAt: now + expiresInSec * 1000,
    };
    if (scope.split(',').map((s) => s.trim()).includes('read_products')) {
      this.variantFieldsAvailable = true;
    }
    return this.tokenCache.token;
  }

  private static isReadProductsVariantError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
      msg.includes('read_products') &&
      (msg.includes('variant field') || msg.includes('"variant"'))
    );
  }

  private static async graphqlWithVariantFallback<T>(
    fullQuery: string,
    liteQuery: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    if (this.variantFieldsAvailable === false) {
      return this.graphql<T>(liteQuery, variables);
    }
    try {
      const data = await this.graphql<T>(fullQuery, variables);
      if (this.variantFieldsAvailable === null) this.variantFieldsAvailable = true;
      return data;
    } catch (err) {
      if (!this.isReadProductsVariantError(err)) throw err;
      console.warn(
        '[bioma shopify] Falta scope read_products — usando query sin variant (glosas pueden perder peso de opción Tamaño). Actualiza scopes en Dev Dashboard.',
      );
      this.variantFieldsAvailable = false;
      return this.graphql<T>(liteQuery, variables);
    }
  }

  private static async graphql<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
    const token = await this.getAccessToken();
    const url = `https://${this.storeDomain}/admin/api/${this.apiVersion}/graphql.json`;
    const res = await axios.post(
      url,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': token,
        },
        validateStatus: () => true,
      },
    );
    if (res.status !== 200) {
      throw new Error(`Shopify GraphQL HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }
    if (res.data?.errors?.length) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(res.data.errors)}`);
    }
    return res.data.data as T;
  }

  /** Lists orders pending invoice emission. */
  static async listPending(options: ListPendingOptions = {}): Promise<{
    orders: ShopifyOrderForBioma[];
    pageInfo: PageInfo;
  }> {
    const tag = options.tag ?? this.facturaTag;
    const excludeTag = options.excludeTag ?? this.facturaEmitidaTag;
    const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 250);
    const after = options.after ?? null;

    const parts: string[] = [`tag:${tag}`];
    if (options.paidOnly === true) {
      parts.push('financial_status:paid');
    }
    const queryStr = parts.join(' ');

    const [ordersData, draftsData] = await Promise.all([
      this.graphqlWithVariantFallback<{ orders: any }>(ORDERS_QUERY, ORDERS_QUERY_LITE, {
        cursor: after,
        query: queryStr,
        first: pageSize,
      }),
      this.graphqlWithVariantFallback<{ draftOrders: any }>(
        DRAFT_ORDERS_QUERY,
        DRAFT_ORDERS_QUERY_LITE,
        {
          cursor: null,
          query: `tag:${tag}`,
          first: pageSize,
        },
      ).catch((err) => {
        console.warn('[bioma] draftOrders query failed (non-fatal):', err?.message);
        return { draftOrders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } };
      }),
    ]);

    const orderEdges = ordersData.orders?.edges ?? [];
    const draftEdges = draftsData.draftOrders?.edges ?? [];

    const orders = [
      ...orderEdges.map((edge: any) => mapOrderNode(edge.node)),
      ...draftEdges
        .filter((edge: any) => edge.node?.status !== 'COMPLETED')
        .map((edge: any) => mapDraftOrderNode(edge.node)),
    ].filter((o: ShopifyOrderForBioma) => {
      if (orderHasFacturaPendienteTag(o.tags)) return true;
      return !orderHasEmitidoShopifyTag(o.tags);
    });

    const seenIds = new Set<string>();
    const dedupedOrders = orders.filter((o) => {
      if (seenIds.has(o.id)) return false;
      seenIds.add(o.id);
      return true;
    });

    return {
      orders: dedupedOrders,
      pageInfo: {
        hasNextPage: ordersData.orders?.pageInfo?.hasNextPage ?? false,
        endCursor: ordersData.orders?.pageInfo?.endCursor ?? null,
      },
    };
  }

  static async getOrder(orderId: string): Promise<ShopifyOrderForBioma | null> {
    const data = await this.graphqlWithVariantFallback<{ order: any | null }>(
      ORDER_FETCH_QUERY,
      ORDER_FETCH_QUERY_LITE,
      { id: orderId },
    );
    if (!data.order) return null;
    return mapOrderNode(data.order);
  }

  static async addTags(resourceId: string, tags: string[]): Promise<void> {
    const data = await this.graphql<{ tagsAdd: { userErrors: any[] } }>(TAGS_ADD_MUTATION, {
      id: resourceId,
      tags,
    });
    const errors = data.tagsAdd?.userErrors ?? [];
    if (errors.length) throw new Error(`tagsAdd userErrors: ${JSON.stringify(errors)}`);
  }

  static async removeTags(resourceId: string, tags: string[]): Promise<void> {
    const data = await this.graphql<{ tagsRemove: { userErrors: any[] } }>(TAGS_REMOVE_MUTATION, {
      id: resourceId,
      tags,
    });
    const errors = data.tagsRemove?.userErrors ?? [];
    if (errors.length) throw new Error(`tagsRemove userErrors: ${JSON.stringify(errors)}`);
  }

  /** Pedidos pagados recientes (para sync boletas / reconciliar). */
  static async listPaidOrders(opts: {
    pageSize?: number;
    after?: string | null;
    daysBack?: number;
  } = {}): Promise<{ orders: ShopifyOrderForBioma[]; pageInfo: PageInfo }> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
    const after = opts.after ?? null;
    const daysBack = opts.daysBack ?? 14;
    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    since.setHours(0, 0, 0, 0);
    const sinceIso = since.toISOString().split('T')[0];
    const sinceMs = since.getTime();

    // Priorizar ventana reciente en la búsqueda de Shopify
    const queryStr = `financial_status:paid created_at:>=${sinceIso}`;
    const data = await this.graphqlWithVariantFallback<{ orders: any }>(
      ORDERS_QUERY,
      ORDERS_QUERY_LITE,
      {
        cursor: after,
        query: queryStr,
        first: pageSize,
      },
    );
    const edges = data.orders?.edges ?? [];
    const orders = edges
      .map((edge: any) => mapOrderNode(edge.node))
      .filter((o: ShopifyOrderForBioma) => {
        if (o.displayFinancialStatus !== 'PAID') return false;
        if (orderHasEmitidoShopifyTag(o.tags)) return false;
        const t = o.processedAt ? new Date(o.processedAt).getTime() : 0;
        return !t || t >= sinceMs;
      });
    return {
      orders,
      pageInfo: {
        hasNextPage: data.orders?.pageInfo?.hasNextPage ?? false,
        endCursor: data.orders?.pageInfo?.endCursor ?? null,
      },
    };
  }

  /**
   * Registra un pedido pagado como factura o boleta (webhook + sync).
   */
  static async processPaidOrder(order: ShopifyOrderForBioma): Promise<{
    tagged: boolean;
    orderName?: string;
    reason?: string;
    kind?: 'factura' | 'boleta';
    autoQueued?: boolean;
  }> {
    const orderGid = order.id;
    const { BiomaFacturacionService } = await import('./BiomaFacturacionService');
    const { BiomaAutoEmitService } = await import('./BiomaAutoEmitService');

    if (order.displayFinancialStatus !== 'PAID') {
      return { tagged: false, orderName: order.name, reason: 'no pagado' };
    }

    if (orderWantsFacturaEmit(order)) {
      if (orderHasEmitidoShopifyTag(order.tags)) {
        return { tagged: false, orderName: order.name, reason: 'ya emitido', kind: 'factura' };
      }
      const fields = extractFacturaFieldsFromOrder(order);
      const rut =
        getOrderCustomAttribute(order.customAttributes, BIOMA_FACTURA_ATTR.rut) || fields.rut;
      if (!rut && !orderHasFacturaPendienteTag(order.tags)) {
        console.warn(`[bioma] ${order.name}: factura requerida pero sin RUT — no se etiqueta`);
        return { tagged: false, orderName: order.name, reason: 'sin RUT', kind: 'factura' };
      }
      if (!order.tags.includes(this.facturaTag)) {
        await this.addTags(orderGid, [this.facturaTag]);
      }
      await BiomaFacturacionService.upsertFromShopify(order);
      let autoQueued = false;
      if (BiomaAutoEmitService.isAutoEmitFacturaEnabled()) {
        BiomaAutoEmitService.enqueue(orderGid, 'factura');
        autoQueued = true;
      }
      return { tagged: true, orderName: order.name, kind: 'factura', autoQueued };
    }

    return this.registerBoletaOrder(order);
  }

  /** B2C sin toggle/RUT factura → boleta tipo 39 en DB + tag opcional. */
  static async registerBoletaOrder(order: ShopifyOrderForBioma): Promise<{
    tagged: boolean;
    orderName?: string;
    reason?: string;
    kind: 'boleta';
    autoQueued?: boolean;
  }> {
    const orderGid = order.id;
    const { BiomaFacturacionService } = await import('./BiomaFacturacionService');
    const { BiomaAutoEmitService } = await import('./BiomaAutoEmitService');

    if (orderHasEmitidoShopifyTag(order.tags)) {
      return { tagged: false, orderName: order.name, reason: 'ya emitido', kind: 'boleta' };
    }

    const existing = await BiomaFacturacionService.findEmision(orderGid);
    if (existing?.status === 'emitted') {
      return { tagged: false, orderName: order.name, reason: 'ya emitida en DB', kind: 'boleta' };
    }

    if (orderWantsFacturaEmit(order)) {
      return { tagged: false, orderName: order.name, reason: 'requiere factura', kind: 'boleta' };
    }
    if (!order.tags.includes(DEFAULT_BOLETA_TAG)) {
      await this.addTags(orderGid, [DEFAULT_BOLETA_TAG]).catch(() => {});
    }

    const row = await BiomaFacturacionService.upsertFromShopify(order);
    if (row.tipoCodigo !== 39 && row.status !== 'emitted') {
      await BiomaFacturacionService.setTipoCodigo(orderGid, 39);
    }

    let autoQueued = false;
    if (BiomaAutoEmitService.isAutoEmitBoletaEnabled()) {
      BiomaAutoEmitService.enqueue(orderGid, 'boleta');
      autoQueued = true;
    }
    return { tagged: true, orderName: order.name, kind: 'boleta', autoQueued };
  }

  /** Convenience: tag emitida con folio SII. */
  static async markEmitted(orderId: string, folio: number): Promise<void> {
    const emitTag = facturaEmitidaTag(folio);
    await this.addTags(orderId, [emitTag]);
    await this.removeTags(orderId, [this.facturaTag, FACTURA_EMITIDA_TAG]);
  }

  static async markBoletaEmitted(orderId: string, folio: number): Promise<void> {
    const emitTag = boletaEmitidaTag(folio);
    await this.addTags(orderId, [emitTag]);
    await this.removeTags(orderId, [DEFAULT_BOLETA_TAG, BOLETA_EMITIDA_TAG, this.facturaTag]);
  }

  /** Restaura tag `factura` tras anular en SII (NC manual) para re-emitir. */
  static async revertFacturaForNotaCredito(
    orderId: string,
    folioAnterior: number | null,
  ): Promise<void> {
    const order = await this.getOrder(orderId);
    const tagsToRemove = new Set<string>(['facturado', FACTURA_EMITIDA_TAG]);
    if (folioAnterior && folioAnterior > 0) {
      tagsToRemove.add(facturaEmitidaTag(folioAnterior));
    }
    for (const tag of order?.tags ?? []) {
      const t = tag.trim();
      if (/^factura #\d+$/i.test(t) || /^boleta #\d+$/i.test(t)) tagsToRemove.add(t);
    }
    if (tagsToRemove.size) {
      await this.removeTags(orderId, [...tagsToRemove]).catch(() => {});
    }
    if (!order?.tags.includes(this.facturaTag)) {
      await this.addTags(orderId, [this.facturaTag]).catch(() => {});
    }
  }

  /** Marca pedido según tipo DTE emitido. */
  static async markDteEmitted(orderId: string, tipoCodigo: number, folio: number): Promise<void> {
    if (tipoCodigo === 39 || tipoCodigo === 41) {
      await this.markBoletaEmitted(orderId, folio);
    } else {
      await this.markEmitted(orderId, folio);
    }
  }

  /**
   * Webhook orders/paid: si el cliente activó factura en checkout, agrega tag `factura`
   * para que aparezca en el workbench (BiomaFacturacion).
   */
  static async handleOrderPaidWebhook(payload: {
    admin_graphql_api_id?: string;
    name?: string;
  }): Promise<{
    tagged: boolean;
    orderName?: string;
    reason?: string;
    kind?: 'factura' | 'boleta';
    autoQueued?: boolean;
  }> {
    const orderGid = payload.admin_graphql_api_id;
    if (!orderGid) {
      return { tagged: false, reason: 'sin admin_graphql_api_id' };
    }

    const order = await this.getOrder(orderGid);
    if (!order) {
      return { tagged: false, orderName: payload.name, reason: 'pedido no encontrado' };
    }

    return this.processPaidOrder(order);
  }
}
