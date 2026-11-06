import { z } from 'zod';
export const uuid = z.uuid();
export const idParams = z.object({ id: uuid }).strict();
const password = z
  .string()
  .min(12)
  .max(72)
  .refine((s) => Buffer.byteLength(s, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes');
export const registerSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z
      .email()
      .max(254)
      .transform((s) => s.toLowerCase()),
    password,
  })
  .strict();
export const loginSchema = registerSchema.omit({ name: true });
export const categorySchema = z
  .object({ name: z.string().trim().min(1).max(100), active: z.boolean().optional() })
  .strict();
export const productSchema = z
  .object({
    category_id: uuid,
    name: z.string().trim().min(1).max(150),
    description: z.string().max(5000).default(''),
    price_cents: z.number().int().min(1).max(100000000),
    active: z.boolean().optional(),
  })
  .strict();
export const page = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const productsQuery = z
  .object({
    ...page,
    q: z.string().max(150).optional(),
    category_id: uuid.optional(),
    available: z.enum(['true', 'false']).optional(),
    sort: z.enum(['name', 'price_cents', 'created_at']).default('created_at'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
export const status = z.enum(['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']);
const date = z.iso.datetime({ offset: true });
export const orderQuery = z
  .object({ ...page, status: status.optional(), from: date.optional(), to: date.optional() })
  .strict()
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), 'from must precede to');
export const reportQuery = z
  .object({
    from: date.optional(),
    to: date.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    threshold: z.coerce.number().int().min(0).max(1000000).default(10),
  })
  .strict()
  .refine((v) => !v.from || !v.to || new Date(v.from) <= new Date(v.to), 'from must precede to');
export const orderSchema = z
  .object({
    items: z
      .array(z.object({ product_id: uuid, quantity: z.number().int().min(1).max(100) }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.product_id)).size === v.items.length,
    'Duplicate products are not allowed',
  );
export const inventorySchema = z
  .object({
    quantity: z
      .number()
      .int()
      .min(-1000000)
      .max(1000000)
      .refine((n) => n !== 0),
  })
  .strict();
export const statusSchema = z.object({ status }).strict();
export const validate =
  (schema, part = 'body') =>
  (req, _res, next) => {
    req.validated ??= {};
    req.validated[part] = schema.parse(req[part]);
    next();
  };
