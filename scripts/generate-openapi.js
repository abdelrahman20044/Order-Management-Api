import { writeFile } from 'node:fs/promises';
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (minimum, maximum) => ({ type: 'integer', minimum, ...(maximum ? { maximum } : {}) });
const uuid = str({ format: 'uuid' }),
  bool = { type: 'boolean' },
  money = str({
    pattern: '^[0-9]+$',
    description: 'Integer cents serialized as a decimal string (PostgreSQL bigint).',
  });
const obj = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const arr = (items) => ({ type: 'array', items });
const states = ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const schemas = {
  Error: obj({
    error: obj(
      { code: str(), message: str(), requestId: str(), details: arr({ type: 'object' }) },
      ['code', 'message'],
    ),
  }),
  User: obj({
    id: uuid,
    name: str(),
    email: str({ format: 'email' }),
    role: str({ enum: ['customer', 'admin'] }),
  }),
  Register: obj({
    name: str({ minLength: 1, maxLength: 100 }),
    email: str({ format: 'email', maxLength: 254 }),
    password: str({ minLength: 12, maxLength: 72, description: 'At most 72 UTF-8 bytes.' }),
  }),
  Login: obj({ email: str({ format: 'email' }), password: str({ minLength: 12, maxLength: 72 }) }),
  Tokens: obj({
    user: ref('User'),
    accessToken: str(),
    tokenType: str({ enum: ['Bearer'] }),
    expiresIn: int(1),
  }),
  CategoryInput: obj({ name: str({ minLength: 1, maxLength: 100 }), active: bool }, ['name']),
  Category: obj({ id: uuid, name: str(), active: bool }),
  ProductInput: obj(
    {
      category_id: uuid,
      name: str({ minLength: 1, maxLength: 150 }),
      description: str({ maxLength: 5000, default: '' }),
      price_cents: int(1, 100000000),
      active: bool,
    },
    ['category_id', 'name', 'price_cents'],
  ),
  Product: obj(
    {
      id: uuid,
      category_id: uuid,
      name: str(),
      description: str(),
      price_cents: int(1),
      stock: int(0),
      active: bool,
      created_at: str({ format: 'date-time' }),
      category_name: str(),
    },
    ['id', 'category_id', 'name', 'description', 'price_cents', 'stock', 'active', 'created_at'],
  ),
  OrderInput: obj({
    items: {
      ...arr(obj({ product_id: uuid, quantity: int(1, 100) })),
      minItems: 1,
      maxItems: 100,
      description: 'Distinct product IDs only. Prices and totals are computed by the server.',
    },
  }),
  OrderItem: obj({
    product_id: uuid,
    product_name: str(),
    quantity: int(1, 100),
    unit_price_cents: int(1),
  }),
  HistoryEntry: obj({
    status: str({ enum: states }),
    at: str({ format: 'date-time' }),
    actor_id: uuid,
  }),
  Order: obj(
    {
      id: uuid,
      user_id: uuid,
      status: str({ enum: states }),
      total_cents: money,
      history: arr(ref('HistoryEntry')),
      created_at: str({ format: 'date-time' }),
      updated_at: str({ format: 'date-time' }),
      items: arr(ref('OrderItem')),
    },
    ['id', 'user_id', 'status', 'total_cents', 'history', 'created_at', 'updated_at'],
  ),
  Revenue: obj({ revenue_cents: money, delivered_orders: int(0) }),
  TopProduct: obj({
    id: uuid,
    name: str(),
    units: int(1),
    revenue_cents: money,
    sales_rank: money,
  }),
  OrderCount: obj({ status: str({ enum: states }), count: int(0) }),
  MonthlySales: obj({
    month: str({ format: 'date-time' }),
    revenue_cents: money,
    orders: int(0),
    change_from_previous_active_month_cents: str({
      nullable: true,
      description: 'Signed cents difference; null for the first active month.',
    }),
  }),
  LowStock: obj({ id: uuid, name: str(), stock: int(0), category_name: str() }),
  CustomerHistory: obj({
    id: uuid,
    name: str(),
    order_count: int(0),
    lifetime_revenue_cents: money,
    last_order_at: str({ format: 'date-time', nullable: true }),
  }),
  CustomerOrder: obj({
    id: uuid,
    status: str({ enum: states }),
    total_cents: money,
    created_at: str({ format: 'date-time' }),
  }),
};
for (const [name, item] of [
  ['Products', 'Product'],
  ['Orders', 'Order'],
])
  schemas[name] = obj({ data: arr(ref(item)), total: int(0), page: int(1), limit: int(1, 100) });
const parameter = (name, schema, description) => ({ name, in: 'query', schema, description });
const pagination = [
  parameter('page', { ...int(1, 100000), default: 1 }),
  parameter('limit', { ...int(1, 100), default: 20 }),
];
const dates = ['from', 'to'].map((name) =>
  parameter(
    name,
    str({ format: 'date-time' }),
    `${name === 'from' ? 'Inclusive' : 'Exclusive'} order creation time, with timezone`,
  ),
);
const orderFilters = [...pagination, parameter('status', str({ enum: states })), ...dates];
const reportFilters = [...dates, parameter('limit', { ...int(1, 100), default: 10 })];
const paths = {};
function route(
  method,
  path,
  summary,
  {
    access = 'bearerAuth',
    body,
    response = { type: 'object' },
    status = 200,
    parameters = [],
    description = '',
  } = {},
) {
  const full = path === '/health' ? path : `/api${path}`;
  paths[full] ??= {};
  paths[full][method] = {
    summary,
    description,
    ...(access ? { security: [{ [access]: [] }] } : { security: [] }),
    parameters: [
      ...(path.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: uuid }] : []),
      ...parameters,
    ],
    ...(body
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: typeof body === 'string' ? ref(body) : body },
            },
          },
        }
      : {}),
    responses: {
      [status]: {
        description: status === 201 ? 'Created' : status === 204 ? 'No content' : 'Success',
        ...(status === 204
          ? {}
          : {
              content: {
                'application/json': {
                  schema: typeof response === 'string' ? ref(response) : response,
                },
              },
            }),
        ...(path.startsWith('/auth/') && ['/auth/login', '/auth/refresh'].includes(path)
          ? {
              headers: {
                'Set-Cookie': {
                  description:
                    'Rotated opaque refresh cookie; HttpOnly; SameSite=Strict; Secure in production',
                  schema: str(),
                },
              },
            }
          : {}),
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 500].map((code) => [
          code,
          {
            description: {
              400: 'Invalid input',
              401: 'Unauthenticated',
              403: 'Forbidden',
              404: 'Not found',
              409: 'Conflict',
              429: 'Rate limit',
              500: 'Internal error',
            }[code],
            content: { 'application/json': { schema: ref('Error') } },
          },
        ]),
      ),
    },
  };
}
route('get', '/health', 'Database readiness', {
  access: null,
  response: obj({ status: str({ enum: ['ok', 'unavailable'] }) }),
});
paths['/health'].get.responses[503] = { description: 'Database unavailable' };
route('post', '/auth/register', 'Register a customer', {
  access: null,
  body: 'Register',
  response: 'User',
  status: 201,
});
route('post', '/auth/login', 'Login', { access: null, body: 'Login', response: 'Tokens' });
route('post', '/auth/refresh', 'Rotate refresh token', {
  access: 'refreshCookie',
  response: 'Tokens',
  description:
    'Use the cookie jar from login. Consumed-token replay revokes the family; serialize refresh requests.',
});
route('post', '/auth/logout', 'Revoke refresh family', { access: 'refreshCookie', status: 204 });
route('get', '/auth/me', 'Current public user', { response: 'User' });
for (const [base, input, model] of [
  ['categories', 'CategoryInput', 'Category'],
  ['products', 'ProductInput', 'Product'],
]) {
  route('get', `/${base}`, `List active ${base}`, {
    access: null,
    response: base === 'products' ? 'Products' : arr(ref(model)),
    parameters:
      base === 'products'
        ? [
            ...pagination,
            parameter('q', str({ maxLength: 150 })),
            parameter('category_id', uuid),
            parameter('available', str({ enum: ['true', 'false'] })),
            parameter(
              'sort',
              str({ enum: ['name', 'price_cents', 'created_at'], default: 'created_at' }),
            ),
            parameter('direction', str({ enum: ['asc', 'desc'], default: 'desc' })),
          ]
        : [],
  });
  route('get', `/${base}/{id}`, `Get ${model.toLowerCase()}`, { access: null, response: model });
  route('post', `/${base}`, `Create ${model.toLowerCase()} (admin)`, {
    body: input,
    response: model,
    status: 201,
  });
  route('put', `/${base}/{id}`, `Replace ${model.toLowerCase()} (admin)`, {
    body: input,
    response: model,
  });
  route('delete', `/${base}/{id}`, `Deactivate ${model.toLowerCase()} (admin)`, {
    response: obj({ message: str() }),
  });
}
route('post', '/products/{id}/inventory', 'Adjust stock atomically (admin)', {
  body: obj({ quantity: { ...int(-1000000, 1000000), not: { enum: [0] } } }),
  response: 'Product',
});
route('post', '/orders', 'Create an atomic multi-item order', {
  body: 'OrderInput',
  response: 'Order',
  status: 201,
});
route('get', '/orders', 'List own orders (all for admin)', {
  response: 'Orders',
  parameters: orderFilters,
});
route('get', '/orders/{id}', 'Get own order (or admin)', { response: 'Order' });
route('get', '/orders/{id}/history', 'Order status history (owner/admin)', {
  response: arr(ref('HistoryEntry')),
});
route('post', '/orders/{id}/cancel', 'Cancel pending/confirmed order (owner/admin)', {
  response: 'Order',
});
route('patch', '/orders/{id}/status', 'Advance status (admin)', {
  body: obj({ status: str({ enum: states }) }),
  response: 'Order',
  description:
    'PENDING → CONFIRMED/CANCELLED; CONFIRMED → SHIPPED/CANCELLED; SHIPPED → DELIVERED. Other transitions return 409.',
});
for (const [path, model] of [
  ['revenue', 'Revenue'],
  ['top-products', 'TopProduct'],
  ['order-counts', 'OrderCount'],
  ['monthly-sales', 'MonthlySales'],
  ['low-stock', 'LowStock'],
  ['customer-history', 'CustomerHistory'],
])
  route('get', `/reports/${path}`, `${path} report (admin)`, {
    response: arr(ref(model)),
    parameters:
      path === 'low-stock'
        ? [
            parameter('threshold', { ...int(0, 1000000), default: 10 }),
            parameter('limit', { ...int(1, 100), default: 10 }),
          ]
        : reportFilters,
    description:
      'Revenue/units include DELIVERED orders only; time ranges use order creation. Low-stock is a current snapshot.',
  });
route('get', '/reports/customers/{id}/orders', 'Customer purchase history (admin)', {
  response: arr(ref('CustomerOrder')),
  parameters: orderFilters,
});
const spec = {
  openapi: '3.0.3',
  info: {
    title: 'Order Management API',
    version: '1.0.0',
    description:
      'Integer cents, raw PostgreSQL, atomic stock and refresh rotation. Admin operations require current database role=admin. See README for full operational semantics.',
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local development (use HTTPS in production)' },
  ],
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      refreshCookie: { type: 'apiKey', in: 'cookie', name: 'refresh_token' },
    },
    schemas,
  },
};
await writeFile(
  new URL('../docs/openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);
console.log(
  `Generated ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations`,
);
