// UBICACIÓN — un único subesquema para direcciones de usuario, sucursal
// y la copia de entrega de la orden.

import { text, optionalText, geo, sub } from './helpers.js';

export const locationFields = {
  street: text(200),
  city: text(80),
  state: optionalText(80),
  zipCode: optionalText(10),
  lat: geo(),
  lng: geo(),
};

export const location = sub(locationFields);
