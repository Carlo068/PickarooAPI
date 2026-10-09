// ============================================================
// PERSISTENCIA PICKAROO (Mongoose) — Capa de Infraestructura
//
// Un archivo por modelo. Colecciones: users, categories, products, packages,
// stores, orders, shopping_lists. Cada dato vive en un solo lugar; lo que se
// puede derivar (stock de un paquete, subtotales, descuentos en pesos) se
// calcula.
// ============================================================

import { User } from './user.js';
import { Category } from './category.js';
import { Product } from './product.js';
import { Package } from './package.js';
import { Store } from './store.js';
import { Order } from './order.js';
import { ShoppingList } from './shopping-list.js';

export { User, Category, Product, Package, Store, Order, ShoppingList };

export const models = [User, Category, Product, Package, Store, Order, ShoppingList];
