// SHOPPING_LISTS  (pedidos guardados para volver a comprar)

import mongoose from 'mongoose';
import { text, integer, ref, optionalRef, array, sub, main, assertOneRef } from './helpers.js';

const listItem = sub({
  productId: optionalRef('Product'),
  packageId: optionalRef('Package'),
  quantity: { ...integer(1), default: 1 },
});
listItem.pre('validate', assertOneRef);

const shoppingList = main({
  userId: ref('User'),
  name: text(120),
  items: array(listItem, 200),
});
shoppingList.index({ userId: 1, updatedAt: -1 });
shoppingList.pre('validate', function () {
  const keys = this.items.map(i => String(i.productId ?? i.packageId));
  if (new Set(keys).size !== keys.length) this.invalidate('items', 'La lista tiene partidas duplicadas.');
});

export const ShoppingList = mongoose.model('ShoppingList', shoppingList, 'shopping_lists');
