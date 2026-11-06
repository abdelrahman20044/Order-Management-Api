import { transaction } from '../db.js';
import { AppError, requireFound } from '../errors.js';
export async function adjustStock(id, quantity, actor) {
  return transaction(async (db) => {
    const p = requireFound(
      (await db.query('SELECT * FROM products WHERE id=$1 FOR UPDATE', [id])).rows[0],
    );
    if (p.stock + quantity < 0 || p.stock + quantity > 1000000)
      throw new AppError(409, 'Stock would be outside allowed bounds', 'STOCK_CONFLICT');
    const updated = (
      await db.query('UPDATE products SET stock=stock+$1 WHERE id=$2 RETURNING *', [quantity, id])
    ).rows[0];
    await db.query(
      "INSERT INTO inventory_movements(product_id,actor_id,quantity,reason) VALUES($1,$2,$3,'ADJUSTMENT')",
      [id, actor, quantity],
    );
    return updated;
  });
}
