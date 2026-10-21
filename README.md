# PickarooAPI

Backend GraphQL de Pickaroo para administrar un catálogo comercial, paquetes de productos, sucursales, usuarios, listas de compra y pedidos con recogida o entrega a domicilio. La implementación incluye datos de demostración de CARNYFRUT, orientados a productos para carne asada y parrilladas.

El componente principal es **`services/mongoAPI`**: contiene las reglas de negocio, los modelos documentales de MongoDB y las operaciones de la API. **Apollo Gateway** publica un punto de entrada unificado, mientras que **RabbitMQ** recibe eventos de pedidos para una futura integración de auditoría u otros consumidores. **Redis Stack** guarda las sesiones de inicio de sesión (JWT) y una copia de lectura de productos y usuarios.


## 1. Arquitectura y componentes

```mermaid
flowchart LR
  Cliente[Cliente GraphQL] --> Gateway[Apollo Gateway\nlocalhost:4000]
  Gateway --> API[mongoAPI\nlocalhost:4001]
  API --> Dominio[Reglas de dominio\ndomain/entities.js]
  API --> Mongoose[Modelos Mongoose]
  Mongoose --> Mongo[(MongoDB\nDocker:27017)]
  API --> Rabbit[RabbitMQ\nDocker:5672]
  API --> Redis[(Redis Stack\nDocker:6379)]
```

| Componente | Responsabilidad |
|---|---|
| Apollo Gateway | Componer el subgrafo `pickaroo` y exponer su contrato GraphQL a los clientes. |
| mongoAPI | Ejecutar consultas y mutaciones, coordinar validaciones, persistir documentos y publicar eventos. |
| Dominio | Encapsular reglas de productos, paquetes, inventario, precios, descuentos, entrega y estados de pedidos. |
| Mongoose | Definir tipos, restricciones, subdocumentos, referencias e índices de MongoDB. |
| MongoDB | Almacenar las colecciones del negocio y ejecutar los pipelines analíticos. |
| RabbitMQ | Recibir los eventos `ORDER_CREATED` y `ORDER_STATUS_CHANGED`. No hay consumidor implementado en este repositorio. |
| Redis Stack | Registrar las sesiones activas del JWT y servir como caché de lectura (Redis OM) de productos y usuarios. |

El Gateway y mongoAPI son procesos Node.js ejecutados en el equipo anfitrión. El archivo Compose levanta únicamente MongoDB, RabbitMQ y Redis Stack, no los procesos Node.js.

### Estructura del repositorio

```text
PickarooAPI/
├── README.md
├── package.json
├── docker-compose.yml
├── gateway/
│   ├── package.json
│   └── index.js
└── services/
    └── mongoAPI/
        ├── package.json
        └── src/
            ├── index.js
            ├── auth.js
            ├── schema.graphql
            ├── domain/
            │   └── entities.js
            └── infrastructure/
                ├── redis-om.js
                ├── entity-cache.js
                ├── cart-store.js
                ├── quote-store.js
                ├── recent-orders.js
                ├── passwords.js
                ├── seed.js
                └── models/
                    ├── index.js
                    ├── helpers.js
                    ├── location.js
                    ├── user.js
                    ├── category.js
                    ├── product.js
                    ├── package.js
                    ├── store.js
                    ├── order.js
                    └── shopping-list.js
```

Los archivos `.env` son configuración local y están excluidos de Git.

## 2. Responsabilidades de mongoAPI

### Contrato GraphQL: `src/schema.graphql`

El SDL define los tipos de salida, los inputs, los enums y las operaciones disponibles. Utiliza Apollo Federation 2.3 y declara entidades con `@key(fields: "id")` para `User`, `Category`, `Product`, `Package`, `Store` y `Order`.

El cliente puede solicitar los campos que necesita, incluyendo relaciones como la categoría de un producto o el contenido de un paquete. El esquema también incorpora:

- `DateTime`: fechas serializadas como cadenas ISO-8601.
- `ItemType`: `PRODUCT` y `PACKAGE`; indica qué referencia una partida. Se calcula, no se guarda.
- `Unit`: `UNIDAD`, `KG` y `LITRO`.
- `OrderMode`: `PICKUP` y `DELIVERY`.
- `UserRole`: `CUSTOMER` y `ADMIN`.
- `OrderStatus`: estados del ciclo de vida del pedido.

Los importes se exponen como `Float` en **pesos mexicanos**, no como centavos enteros. Las cantidades de carrito, paquete y stock son enteros; por ejemplo, `quantity: 2` de un producto con `unit: KG` representa dos kilogramos. El contrato actual no admite `quantity: 0.5`.

### Dominio: `src/domain/entities.js`

La capa de dominio no importa Mongoose ni Apollo. Sus clases `Product` y `Package` y sus funciones centralizan las siguientes reglas:

| Elemento | Función |
|---|---|
| `assertProductPersistable` | Exigir nombre válido, precio positivo y stock entero no negativo. |
| `assertPackagePersistable` | Exigir nombre, precio positivo y entre 2 y 40 productos distintos con cantidades enteras positivas. |
| `Package.availableStock` | Calcular cuántos paquetes completos alcanzan con el stock de sus productos. |
| `Package.alaCarteTotal` / `savings` | Comparar el precio fijo del paquete con su contenido comprado por separado. |
| `stockDemand` | Sumar cuánto de cada producto consume una compra, sea suelto o dentro de paquetes. |
| `bestDiscountPercent` | Seleccionar el mayor porcentaje entre los descuentos vigentes. |
| `applyDiscount` | Calcular el precio unitario después del descuento. |
| `priceOrder` | Construir las partidas históricas, validar stock consolidado y calcular subtotal, descuento, envío y total. |
| `deliveryFee` | Determinar el costo de entrega según la sucursal y su umbral de envío gratuito. |
| `assertTransition` | Validar cambios de estado del pedido. |
| `buildOrderNumber` | Generar un número con formato `PK-AAAAMMDD-SUFIJO`. |

`round2` y `sumMoney` redondean los importes a dos decimales usando `Number`. Este comportamiento es distinto del cálculo en centavos con aritmética entera de HITO1.

### Persistencia: `src/infrastructure/models/`

Hay un archivo por modelo (`user.js`, `category.js`, `product.js`, `package.js`, `store.js`, `order.js`, `shopping-list.js`). `helpers.js` reúne las funciones de definición compartidas (`text`, `money`, `integer`, `ref`, `choice`…), `location.js` define la ubicación reutilizada por usuarios, sucursales y órdenes, y `index.js` exporta los modelos y la lista `models`. El resto de la aplicación importa siempre desde `infrastructure/models/index.js`.

Los modelos invocan las reglas del dominio cuando corresponde y agregan validaciones de estructura: textos con límites y `trim`, cantidades enteras, mínimos numéricos, valores enumerados, fechas y arreglos acotados.

Todos los esquemas principales habilitan `timestamps`, que genera `createdAt` y `updatedAt`, y `optimisticConcurrency` para las operaciones de guardado de documentos. Esto no equivale a una transacción entre varias colecciones.

### Coordinación y arranque: `src/index.js`

El proceso del servicio realiza estas acciones:

1. Carga las variables de entorno y lee el SDL desde disco.
2. Espera la conexión con MongoDB antes de iniciar la API.
3. Ejecuta `syncIndexes()` para cada modelo. Los errores de índices se registran como advertencias y no detienen por sí mismos el arranque.
4. Conecta con Redis (espera hasta 3 segundos; si no responde, sigue reintentando en segundo plano).
5. Intenta conectar con RabbitMQ y declarar la cola de eventos.
6. Construye y publica el subgrafo con Apollo Server; el contexto de cada petición valida el JWT.
7. Si `SEED=true`, ejecuta la carga de demostración después de que el servidor empieza a escuchar.

`syncIndexes()` puede crear o eliminar índices para alinearlos con los esquemas. El inicio del servicio no es, por tanto, una operación estrictamente de solo lectura sobre la base.

### Redis: caché de lectura y sesiones

MongoDB sigue siendo la fuente de verdad. Redis Stack (RedisJSON + RediSearch) se usa de dos formas:

| Uso | Claves | TTL | Archivo |
|---|---|---|---|
| Sesiones del JWT | `session:<jti>` → id del usuario | `JWT_TTL_SECONDS` (3600) | `auth.js` |
| Caché de productos (Redis OM, JSON) | `Product:<id>` | 120 s (`CACHE_TTL_PRODUCT`) | `entity-cache.js` |
| Caché de usuarios (Redis OM, JSON) | `User:<id>` | 3600 s (`CACHE_TTL_USER`) | `entity-cache.js` |
| Carrito | `cart:<userId>` (HASH `p:<productId>` / `k:<packageId>` → cantidad) | 7 días, se renueva con cada cambio | `cart-store.js` |
| Cotizaciones | `quote:<uuid>` (JSON con partidas, envío y total) | 15 min | `quote-store.js` |
| Pedidos recientes | `user:<userId>:orders:recent` (LIST de ids, máx. 20) | 24 h | `recent-orders.js` |

#### Carrito y cotizaciones: precios que cambian y productos que desaparecen

- **El carrito no guarda precios**, solo ids y cantidades. Cada lectura (`cart`) lo contrasta con el catálogo actual de MongoDB (`reconcileCart` en el dominio). Un cambio de precio se ve al instante, y lo que ya no se puede comprar aparece en `unavailable` con su motivo (`DELETED`, `INACTIVE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`) en lugar de cobrarse. Desactivar o borrar un producto no exige recorrer los carritos.
- **Una cotización no congela el precio**: es el total que el cliente vio. `quoteOrder` y `cart` devuelven `quoteId`. Si se manda en `createOrder` o `checkoutCart`, la compra se recalcula contra MongoDB y se compara (`assertQuoteStillValid`):
  - precios, descuentos, envío o total distintos → `PRICE_CHANGED`;
  - otros productos, cantidades, sucursal o modo → `QUOTE_MISMATCH`;
  - cotización vencida o ya usada → `QUOTE_EXPIRED`.

  En los tres casos el error trae `extensions.newQuote` (con su propio `quoteId`) para que el cliente confirme el total nuevo. Cada cotización se usa una sola vez. Sin `quoteId` la orden se cobra al precio actual, como antes.
- **`checkoutCart`** compra el carrito del usuario autenticado. Si alguna partida no está disponible se rechaza con `CART_HAS_UNAVAILABLE_ITEMS` (y la lista en `extensions.unavailable`); el carrito se vacía solo cuando la orden se creó.
- **Pedidos recientes** (`recentOrders`): Redis guarda solo los ids; estado e importes se leen de MongoDB. Si la lista no existe se reconstruye desde MongoDB, y una orden nueva entra al inicio solo si la lista ya existe (`LPUSHX`), así nunca queda incompleta.
- Sin Redis: el carrito responde `SERVICE_UNAVAILABLE`; `quoteOrder` sigue cotizando pero sin `quoteId`; `recentOrders` lee de MongoDB. Al reconectar se vacían los cachés y las listas de pedidos recientes, pero **no** los carritos ni las cotizaciones (son estado, no copias).

- **Lectura (cache-aside):** `product(id)`, `User`, `Order.user`, `ShoppingList.user`, `me` y los campos `product` de partidas y paquetes consultan primero Redis; si no está la copia, leen de MongoDB y la guardan con TTL. Los listados (`products`, `users`, `packages`…) van directo a MongoDB.
- **Escritura de productos:** cualquier cambio (`updateProduct`, `setProductStock`, descuentos…) y cada compra o cancelación que mueve el stock **borra** la copia. La siguiente lectura trae el dato nuevo.
- **Escritura de usuarios:** *write-through*. Tras guardar en MongoDB se escribe la copia ya actualizada.
- **Lo que decide un cobro nunca sale del caché.** `createOrder` y `quoteOrder` calculan precios, descuentos y stock contra MongoDB, así que un cambio de precio aplica de inmediato a las compras aunque alguna copia tardara en expirar.
- **Seguridad:** el `passwordHash` no se cachea (el campo es `select: false` y la vista que se guarda no lo incluye).
- **Redis caído:** las lecturas siguen funcionando desde MongoDB; `login` responde `SERVICE_UNAVAILABLE` y los tokens existentes dejan de aceptarse hasta que Redis vuelva (las sesiones no se pueden verificar). Al conectar (o reconectar) se vacían `Product:*` y `User:*` para no servir copias de cambios hechos mientras Redis o la app estaban caídos.
- `CACHE_DEBUG=true` imprime cada `HIT`, `MISS`, `SAVE` y `DEL`.

La interfaz **RedisInsight** (`http://localhost:8001`) permite inspeccionar estas claves.

### Autenticación y autorización: `src/auth.js`

Autenticación híbrida **JWT + sesión activa en Redis**:

1. `login(input: {email, password})` verifica la contraseña (scrypt, comparación en tiempo constante), firma un JWT HS256 con `sub`, `name`, `email`, `role` y un `jti` único, y guarda `session:<jti>` en Redis con el mismo TTL.
2. Cada petición envía `Authorization: Bearer <token>`. El Gateway reenvía el encabezado al subgrafo, que valida la firma y la expiración **y** que `session:<jti>` siga existiendo.
3. `logout` borra `session:<jti>`: el token deja de servir al instante, aunque no haya expirado.

Correo inexistente, contraseña incorrecta y cuenta desactivada devuelven el mismo mensaje (`Credenciales inválidas.`).

Permisos por operación (errores `UNAUTHENTICATED` sin sesión y `FORBIDDEN` sin permiso):

| Acceso | Operaciones |
|---|---|
| Público | `login`, `createUser` (registro; siempre crea `CUSTOMER`), `categories`, `category`, `products`, `product`, `packages`, `package`, `stores`, `store`, `quoteOrder` |
| Sesión iniciada | `me`, `logout`, `cart`, `addToCart`, `setCartItemQuantity`, `removeFromCart`, `clearCart`, `checkoutCart`, `recentOrders` (siempre sobre el usuario del token) |
| Dueño o `ADMIN` | `user`, `addUserAddress`, `setDefaultAddress`, `removeUserAddress`, `createOrder`, `cancelOrder`, `order`, `orderByNumber`, `orders` (un cliente solo ve las suyas), `shoppingLists`, `shoppingList`, `createShoppingList`, `addItemToShoppingList`, `removeItemFromShoppingList`, `deleteShoppingList` |
| Solo `ADMIN` | `users`, `createUser` con `role: ADMIN`, `createCategory`, `createProduct`, `updateProduct`, `setProductActive`, `setProductStock`, `addProductDiscount`, `removeProductDiscount`, `createPackage`, `updatePackage`, `setPackageActive`, `createStore`, `updateStore`, `updateOrderStatus`, `salesReport`, `packageComponentDemand` |

El rol viaja dentro del token y vale hasta que expira o se hace `logout`; cambiar el rol de un usuario en la base no afecta a sus sesiones abiertas.

## 3. Modelo documental

La aplicación exporta siete modelos. Cada dato vive en un solo lugar: lo que se puede derivar de otro dato (stock de un paquete, subtotal, descuento en pesos) se calcula en lugar de guardarse.

| Colección | Información principal | Datos incrustados o referencias |
|---|---|---|
| `users` | Nombre, correo, rol, estado, avatar y `defaultAddressId`. | `addresses[]`: hasta 25 direcciones con `_id`. |
| `categories` | Nombre (único, sin distinguir mayúsculas), icono y orden. | Los productos la referencian mediante `categoryId`. |
| `products` | Nombre, descripción, precio, imagen, unidad, stock y estado. | `discounts[]`: hasta 20 promociones. |
| `packages` | Nombre, descripción, precio fijo, imagen y estado. **Sin stock propio.** | `items[]`: entre 2 y 40 productos con su cantidad. |
| `stores` | Nombre, contacto, horario y política de reparto. | `address`: ubicación incrustada. |
| `orders` | Número, usuario, sucursal, modalidad, estado, envío, total y notas. | `items[]`: hasta 200 partidas; `deliveryAddress`: copia de la ubicación. |
| `shopping_lists` | Usuario y nombre de la lista. | `items[]`: hasta 200 partidas de productos o paquetes. |

### Incrustación

Se utiliza cuando la información pertenece al documento principal, está acotada y se lee junto con él:

- Las direcciones están dentro de `users.addresses`; la predeterminada se indica con `users.defaultAddressId`.
- La dirección de una sucursal está en `stores.address`, con la misma forma (`street`, `city`, `state`, `zipCode`, `lat`, `lng`) que la de usuarios y que la copia de entrega de una orden.
- Los descuentos están dentro de `products.discounts`.
- El contenido de un paquete está dentro de `packages.items`.
- Las partidas están dentro de `orders.items` y `shopping_lists.items`.

### Referenciación

Las relaciones compartidas o sin límite de crecimiento se representan con `ObjectId`: la categoría de un producto, los productos de un paquete, el usuario y la sucursal de un pedido, y el producto **o** paquete de cada partida (`productId` o `packageId`, nunca ambos).

Los pedidos se conservan en su propia colección para que el historial de un usuario crezca sin quedar incrustado en su documento. Una referencia Mongoose no es una clave foránea que MongoDB verifique automáticamente: la aplicación comprueba la existencia de entidades en distintas operaciones.

### Índices principales

- Correo de usuario único y nombre de categoría único (colación `es`, sin distinguir mayúsculas).
- Número de pedido único.
- Usuario y clave de idempotencia únicos cuando la clave es una cadena.
- Categoría y estado activo de productos; índice de texto sobre nombre y descripción.
- `packages.items.productId`, para saber qué paquetes contienen un producto.
- Pedidos por usuario, estado, fecha y sucursal.
- Listas por usuario y fecha de actualización.

## 4. Productos y paquetes

### Producto

Es una unidad vendible del catálogo, con precio, unidad (`UNIDAD`, `KG` o `LITRO`) y stock propios. `createProduct` comprueba que exista la categoría y persiste el documento validado.

### Paquete

Un paquete (por ejemplo, el combo para carne asada) vive en su propia colección `packages`. Se crea con `createPackage`, indicando nombre, precio y contenido; se edita con `updatePackage` y se activa o desactiva con `setPackageActive`.

```javascript
items: [
  { productId: "ID_ARRACHERA", quantity: 2 },
  { productId: "ID_CARBON", quantity: 1 }
]
```

- Entre 2 y 40 productos distintos, con cantidades enteras positivas. Como el contenido solo puede referenciar `products`, un paquete no puede contener otro paquete ni a sí mismo.
- **Precio fijo** definido por el administrador. Los campos `alaCarteTotal` y `savings` lo comparan contra el precio efectivo actual de su contenido; `savings` puede ser negativo.
- **Sin stock propio.** `availableStock` es el número de paquetes completos que alcanzan con el stock de sus productos (por ejemplo, 2 kg de arrachera por paquete y 50 kg en stock permiten 25). Si alguno de sus productos está desactivado, el paquete no está disponible.
- Los paquetes no tienen descuentos propios; su precio fijo ya es la oferta.

### Imágenes

`imageUrl` está disponible en productos y paquetes. Permite guardar y consultar una URL externa, por ejemplo de Cloudinary. La API no sube archivos ni almacena los bytes de la imagen.

Mongoose limita la longitud a 500 caracteres y elimina espacios en los extremos; no valida que el texto sea una URL HTTPS ni comprueba que la imagen exista.

## 5. Descuentos

Las promociones se guardan como subdocumentos de `products.discounts`, con identificador propio:

| Campo | Significado |
|---|---|
| `percent` | Porcentaje entre 0.01 y 100. Por ejemplo, `10` significa 10%. |
| `label` | Descripción opcional de la promoción. |
| `startsAt` | Inicio opcional; `null` significa sin restricción de inicio. |
| `endsAt` | Fin opcional; `null` significa sin vencimiento. |

Una promoción está vigente dentro de su ventana de fechas; `isCurrent` lo indica en GraphQL. Para detenerla se elimina con `removeProductDiscount` o se registra con un `endsAt`. Cuando hay varias vigentes se utiliza el mayor porcentaje y no se acumulan.

`activeDiscountPercent` muestra el porcentaje elegido y `effectivePrice` el precio unitario resultante. Al comprar, la partida conserva el precio de lista, el porcentaje aplicado y el importe.

El esquema admite 100%, por lo que el importe final puede ser cero aunque el precio base sea positivo. La etiqueta de una promoción es descriptiva: escribir `2x1` no implementa una mecánica de dos por uno.

## 6. Cotización y ciclo de pedidos

### Cotizar sin guardar

`quoteOrder` recibe modalidad, sucursal opcional y partidas; cada partida indica `productId` **o** `packageId`. Carga el catálogo, comprueba disponibilidad y calcula importes sin crear un pedido ni descontar stock.

El cálculo utiliza:

```text
precio unitario efectivo = redondear(precio base × (1 − porcentaje / 100))
importe de partida       = redondear(precio unitario efectivo × cantidad)
descuento de partida     = precio base × cantidad − importe de partida
subtotal                 = suma de precios base × cantidades
total                    = subtotal − descuentos + envío
```

Un paquete se cobra a su precio fijo, sin porcentaje. La disponibilidad se valida **consolidada por producto**: si el carrito lleva 1 paquete con 2 kg de arrachera y además 49 kg sueltos, se exigen 51 kg. La cotización no reserva existencias.

### Política de entrega

- `PICKUP`: el envío cuesta cero.
- `DELIVERY`: utiliza `deliveryFee` de la sucursal.
- Si el subtotal después de descuentos alcanza `freeDeliveryThreshold`, el envío cuesta cero.
- Si no se indica sucursal, la operación busca la primera sucursal activa. Una sucursal indicada que esté inactiva se rechaza.

Al crear una orden de entrega, la ubicación se obtiene, en este orden, de una ubicación enviada explícitamente, un `addressId` del usuario, su dirección predeterminada o la primera disponible. Se exige dirección al crear la orden de entrega, pero no al cotizar.

### Crear y conservar el historial

`createOrder` verifica que el usuario exista y esté activo, resuelve la sucursal, vuelve a calcular precios, **aparta el stock**, guarda el pedido con estado inicial `PENDING` y publica `ORDER_CREATED`.

La orden es un recibo inmutable. Cada partida guarda solo lo cobrado: referencia (`productId` o `packageId`), nombre, unidad, cantidad, precio de lista, porcentaje aplicado e importe. Si se compró un paquete, copia su contenido (`contents`). La orden guarda además `deliveryFee` y `total` (lo cobrado al cliente). El descuento en pesos de cada partida, el `subtotal` y el `discountTotal` **se derivan** de las partidas y GraphQL los calcula al consultarlos. La ubicación de entrega también se copia; editar luego la dirección del usuario no modifica el pedido.

La clave opcional `idempotencyKey` evita crear otra orden para el mismo usuario y clave. El código devuelve la orden existente sin comparar el contenido de las dos solicitudes; una compra nueva debe usar una clave nueva.

### Estados permitidos

| Estado actual | Estados siguientes |
|---|---|
| `PENDING` | `CONFIRMED`, `CANCELLED` |
| `CONFIRMED` | `PREPARING`, `CANCELLED` |
| `PREPARING` | `READY`, `CANCELLED` |
| `READY` | `IN_DELIVERY`, `DELIVERED`, `CANCELLED` |
| `IN_DELIVERY` | `DELIVERED`, `CANCELLED` |
| `DELIVERED` | Ninguno |
| `CANCELLED` | Ninguno |

`updateOrderStatus` aplica estas transiciones y publica `ORDER_STATUS_CHANGED`. `cancelOrder` delega en esa operación. Repetir el mismo estado se rechaza; la tabla no distingue entre entrega y recogida.

### Inventario

El stock vive **solo** en `products.stock`; no se separa por sucursal. Los paquetes no tienen stock: vender un paquete descuenta cada producto de su contenido multiplicado por la cantidad comprada.

Al crear una orden, cada producto se descuenta con un `updateOne` condicionado a `stock >= cantidad`. Si algún producto no alcanza, se devuelve lo ya descontado y la compra se rechaza; si falla el guardado de la orden, también se devuelve el stock. Esto evita la sobreventa entre compras concurrentes, aunque no es una transacción multidocumento. Al cancelar se guarda el estado y luego se repone el stock consumido, incluido el contenido de los paquetes.

## 7. Operaciones GraphQL

El SDL es la referencia completa de argumentos y tipos. Las operaciones se organizan así:

| Área | Queries | Mutations |
|---|---|---|
| Sesión | `me` | `login`, `logout` |
| Usuarios | `users`, `user` | `createUser`, `addUserAddress`, `setDefaultAddress`, `removeUserAddress` |
| Categorías | `categories`, `category` | `createCategory` |
| Productos | `products`, `product` | `createProduct`, `updateProduct`, `setProductActive`, `setProductStock` |
| Paquetes | `packages`, `package` | `createPackage`, `updatePackage`, `setPackageActive` |
| Descuentos | Campos `discounts`, `activeDiscountPercent`, `effectivePrice` de `Product` | `addProductDiscount`, `removeProductDiscount` |
| Sucursales | `stores`, `store` | `createStore`, `updateStore` |
| Carrito | `cart` | `addToCart`, `setCartItemQuantity`, `removeFromCart`, `clearCart`, `checkoutCart` |
| Pedidos | `quoteOrder`, `orders`, `order`, `orderByNumber`, `recentOrders` | `createOrder`, `updateOrderStatus`, `cancelOrder` |
| Listas | `shoppingLists`, `shoppingList` | `createShoppingList`, `addItemToShoppingList`, `removeItemFromShoppingList`, `deleteShoppingList` |
| Analítica | `salesReport`, `packageComponentDemand` | — |

`products` admite filtros por categoría, búsqueda de texto y estado activo. Productos, usuarios y pedidos usan `limit` y `offset`; el código limita el máximo de `limit` a 100, pero no implementa una validación completa de límites inferiores. Otros listados no están paginados.

GraphQL permite seleccionar campos de respuesta. Sin embargo, los resolvers actuales no implementan DataLoader ni derivan proyecciones MongoDB de la selección del cliente; una consulta con muchas relaciones puede ejecutar lecturas adicionales por cada elemento.

## 8. Consultas analíticas en MongoDB

### `salesReport(from, to)`

Consolida las ventas de pedidos `DELIVERED` cuya **fecha de creación** está dentro del rango, con ambos extremos inclusivos.

```text
$match → $unwind(items) → $group(productId, packageId) → $sort(revenue)
```

Devuelve tipo (`PRODUCT` o `PACKAGE`), identificador, nombre, cantidad, ingresos netos de partidas y número de pedidos distintos. Los ingresos no incluyen la tarifa de envío ni distribuyen el ingreso de un paquete entre su contenido.

### `packageComponentDemand(from, to)`

Calcula los productos necesarios para surtir paquetes de pedidos no cancelados. Incluye pedidos pendientes; no representa exclusivamente ventas entregadas.

```text
$match(pedidos)
→ $unwind(items)
→ $match(items.packageId existe)
→ $unwind(items.contents)
→ $group(productId)
→ $lookup(products)
→ $sort(quantityNeeded)
```

Multiplica la cantidad de cada producto del contenido por el número de paquetes comprados y devuelve:

- `quantityNeeded`: unidades requeridas del producto.
- `packagesSold`: cantidad de paquetes que lo incluyen dentro del rango consultado.
- `inPackages`: número de paquetes distintos que lo incluyen.

Es un reporte de demanda para planear compras; el stock ya se descuenta al vender. El nombre del producto se obtiene del catálogo actual. Las cantidades de diferentes unidades no deben sumarse como si fueran equivalentes.

## 9. RabbitMQ y eventos

La cola predeterminada es `pickaroo.events`, configurable con `RABBITMQ_QUEUE`. Se declara durable y los mensajes se envían con `persistent: true`.

La estructura publicada es:

```javascript
{
  event: "ORDER_CREATED",
  payload: { /* identificadores e información del pedido */ },
  occurredAt: "2026-09-08T12:00:00.000Z"
}
```

Si RabbitMQ no está disponible, la API registra el problema y continúa; los eventos pueden omitirse. No hay outbox, confirmaciones de publicación, reintento de eventos ni reconexión automática implementados. La publicación no forma una transacción con MongoDB.

`cassandra-driver` está declarado como dependencia, pero no hay conexión ni operaciones Cassandra/ScyllaDB en el servicio actual.

## 10. Configuración y ejecución local

### Requisitos

- Node.js compatible con las versiones de Apollo Server declaradas en los paquetes.
- npm con soporte para workspaces.
- Docker Desktop o un motor Docker con Docker Compose activo.
- Puertos `27017`, `5672`, `15672`, `6379`, `8001`, `4000` y `4001` disponibles.

### Instalar dependencias

Desde la raíz de PickarooAPI:

```bash
npm install
```

El proyecto utiliza workspaces para `gateway` y `services/*`. También existe `npm run install:all`, que ejecuta `npm install`. El `.gitignore` actual excluye `package-lock.json`; la instalación no queda fijada por un lockfile versionado en el repositorio.

### Variables de mongoAPI

Crear **`services/mongoAPI/.env`**:

```dotenv
MONGODB_URI=mongodb://admin:CONTRASENA_DEL_COMPOSE@localhost:27017/pickaroodb?authSource=admin
PORT_CAMPAMENTOS=4001
RABBITMQ_URL=amqp://guest:guest@localhost:5672
RABBITMQ_QUEUE=pickaroo.events
REDIS_URL=redis://default:pickaroo123@localhost:6379
JWT_SECRET=CAMBIAR_POR_UN_SECRETO_LARGO_Y_ALEATORIO
JWT_TTL_SECONDS=3600
SEED=false
```

`REDIS_URL` coincide con la contraseña (`--requirepass`) del servicio `redis` del Compose y es también el valor de respaldo del código. `JWT_SECRET` debe definirse: si falta, el servicio genera uno aleatorio al arrancar y todos los tokens dejan de ser válidos en cada reinicio. Para generar uno:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Opcionales: `CACHE_TTL_PRODUCT` (120), `CACHE_TTL_USER` (3600) y `CACHE_DEBUG=true`.

Sustituir `CONTRASENA_DEL_COMPOSE` por el valor de `MONGO_INITDB_ROOT_PASSWORD` del YAML. Si contiene caracteres reservados de una URI, deben codificarse. El usuario y contraseña deben coincidir con los que inicializaron el volumen de MongoDB; editar el YAML no cambia automáticamente las credenciales de un volumen existente.

El valor de respaldo del código es `mongodb://localhost:27017/pickaroodb`, sin autenticación. Para el MongoDB autenticado del Compose se necesita la URI completa.

### Variables del Gateway

Crear **`gateway/.env`**:

```dotenv
PORT_GATEWAY=4000
PORT_CAMPAMENTOS=4001
```

`PORT_CAMPAMENTOS` conserva un nombre del boilerplate, pero configura el puerto de mongoAPI. Debe coincidir en ambos archivos. Al ejecutar los scripts mediante workspaces, cada proceso carga su `.env` desde su propio directorio; un `.env` en la raíz no sustituye automáticamente estos archivos.

### Levantar servicios

Desde la raíz:

```bash
docker compose up -d
npm run dev
```

Para arrancar los procesos por separado:

```bash
npm run dev:campamentos
```

En otra terminal:

```bash
npm run dev:gateway
```

El comando `dev:campamentos` apunta a `services/mongoAPI`; no se debe sustituir por un nombre de script que no esté definido en `package.json`.

| Servicio | Dirección local |
|---|---|
| Gateway GraphQL | `http://localhost:4000/` |
| Subgrafo mongoAPI | `http://localhost:4001/graphql` |
| MongoDB | `localhost:27017`, base recomendada `pickaroodb` |
| RabbitMQ AMQP | `localhost:5672` |
| Panel RabbitMQ | `http://localhost:15672/` |
| Redis Stack | `localhost:6379` |
| RedisInsight | `http://localhost:8001/` |

El Gateway intenta componer el subgrafo hasta 15 veces, con una espera de dos segundos entre fallos. Es necesario que mongoAPI llegue a estar disponible dentro de ese periodo.

### Persistencia y apagado

Compose utiliza `mongo:8.0`, `rabbitmq:3.13-management` y `redis/redis-stack:latest`, con la red `pickaroo-network` y los volúmenes:

- `mongodb_data`, montado en `/data/db`.
- `rabbitmq_data`, montado en `/var/lib/rabbitmq`.
- `redis_data`, montado en `/data` (Redis con `--appendonly yes`, así las sesiones sobreviven a un reinicio del contenedor).

```bash
docker compose ps
docker compose logs --tail=100 mongodb rabbitmq redis
docker compose down
```

`down` conserva los volúmenes; `down -v` los elimina (y con ellos las sesiones y el caché). MongoDB está configurado como standalone, sin replica set. Si el MongoDB, RabbitMQ o Redis de HITO1 (o de otro proyecto) sigue publicando los puertos `27017`, `5672`, `6379` o `8001`, ambos Compose no podrán utilizarlos simultáneamente.

## 11. Datos de demostración

Para habilitar el seed, establecer `SEED=true` en el `.env` de mongoAPI y reiniciar ese proceso. La carga se ejecuta después de iniciar el servidor, por lo que debe esperarse al mensaje `Seed OK` antes de consultar los ejemplos.

En una base vacía crea:

- Una sucursal `CARNYFRUT Centro`, con tarifa de reparto de $35 y envío gratuito desde $400 después de descuentos.
- Dos usuarios de demostración; el cliente tiene una dirección predeterminada. Sus contraseñas (solo desarrollo) son `Admin1234` para `admin@carnyfrut.mx` y `Cliente1234` para `cliente@demo.mx`; se pueden cambiar con `SEED_ADMIN_PASSWORD` y `SEED_CUSTOMER_PASSWORD`. El seed las asigna también a usuarios de demostración ya existentes que no tengan contraseña.
- Cuatro categorías: Carnes, Frutas, Verduras y Abarrotes.
- Once productos y, en la colección `packages`, un paquete familiar para carne asada con ocho productos.
- Una promoción del 15% incrustada en el producto Plátano.

El seed no crea pedidos ni listas de compra. Busca registros existentes por nombre o correo y no sobrescribe sus datos comerciales. Esta estrategia evita duplicados en ejecuciones secuenciales normales, pero los nombres de producto, paquete y sucursal no tienen un índice único que garantice lo mismo ante ejecuciones concurrentes.

> **Bases creadas antes de este modelo:** los documentos con `slug`, `kind`, `components`, `discountPercentage` o la dirección de sucursal como texto no son compatibles. En desarrollo, vaciar la base (`docker compose exec mongodb mongosh -u admin -p --authenticationDatabase admin pickaroodb --eval "db.dropDatabase()"`) y volver a cargar el seed.

Los datos, precios y cantidades del seed son demostrativos. No equivalen a los 14 productos y seis portafolios preparados en HITO1. Después de cargar los ejemplos puede establecerse `SEED=false` para evitar repetir el proceso en cada arranque.

## 12. Ejemplos de uso

Ejecutar las operaciones en el Gateway. Los identificadores de los ejemplos deben sustituirse por los obtenidos de la base actual.

### Iniciar sesión

La mayoría de las operaciones requieren sesión (ver la tabla de permisos en la sección 2). Para el seed:

```graphql
mutation Login($input: LoginInput!) {
  login(input: $input) {
    token
    expiresIn
    user { id name role }
  }
}
```

Variables: `{ "input": { "email": "admin@carnyfrut.mx", "password": "Admin1234" } }`.

Copiar `token` y enviarlo en cada petición como encabezado `Authorization: Bearer <token>` (en Apollo Sandbox, pestaña *Headers*). `query { me { id name role } }` confirma la sesión y `mutation { logout }` la revoca.

Las demás consultas de este apartado se ejecutan con ese encabezado; el catálogo (`products`, `packages`, `stores`) y `quoteOrder` también funcionan sin él. Para `users`, los reportes y las mutaciones de catálogo se necesita el token del administrador; para `createOrder` y las listas, el del cliente (o el del administrador).

### Explorar catálogo y paquetes

```graphql
query Catalogo {
  products(limit: 20, offset: 0) {
    id
    name
    unit
    price
    effectivePrice
    activeDiscountPercent
    imageUrl
    stock
    category { id name }
  }
  packages {
    id
    name
    price
    availableStock
    alaCarteTotal
    savings
    items {
      quantity
      product { id name unit }
    }
  }
  stores { id name address { street city } deliveryFee freeDeliveryThreshold }
  users(limit: 10) { id name addresses { id label street isDefault } } # solo ADMIN
}
```

### Cotizar un carrito

```graphql
query Cotizar($input: QuoteInput!) {
  quoteOrder(input: $input) {
    mode
    subtotal
    discountTotal
    deliveryFee
    total
    items { type name quantity unitPrice discountPercent lineTotal }
  }
}
```

Variables (cada partida lleva `productId` **o** `packageId`):

```json
{
  "input": {
    "mode": "PICKUP",
    "storeId": "ID_SUCURSAL",
    "items": [
      { "packageId": "ID_PAQUETE", "quantity": 1 },
      { "productId": "ID_PRODUCTO", "quantity": 2 }
    ]
  }
}
```

### Crear una orden

Esta operación persiste una orden y descuenta stock; no es una consulta de prueba sin efectos. Los valores de enum (`mode`) van sin comillas cuando se escriben directamente en la operación.

```graphql
mutation Comprar($input: CreateOrderInput!) {
  createOrder(input: $input) {
    id
    number
    status
    subtotal
    discountTotal
    deliveryFee
    total
    items { type name quantity lineTotal contents { quantity product { name } } }
  }
}
```

Variables:

```json
{
  "input": {
    "userId": "ID_USUARIO",
    "mode": "PICKUP",
    "storeId": "ID_SUCURSAL",
    "idempotencyKey": "compra-ejemplo-001",
    "items": [
      { "packageId": "ID_PAQUETE", "quantity": 1 }
    ]
  }
}
```

### Comprar con el carrito (Redis)

Con el token del cliente:

```graphql
mutation { addToCart(packageId: "ID_PAQUETE", quantity: 1) { itemCount } }
```

```graphql
query Carrito {
  cart(mode: PICKUP) {
    items { type quantity available product { name } package { name } }
    unavailable { name reason availableQuantity }
    quote { quoteId expiresAt subtotal discountTotal deliveryFee total }
    quoteError
  }
}
```

```graphql
mutation Pagar($input: CheckoutCartInput!) {
  checkoutCart(input: $input) { id number total status }
}
```

Variables: `{ "input": { "mode": "PICKUP", "quoteId": "QUOTE_ID_DEL_CARRITO", "idempotencyKey": "carrito-001" } }`.

Si un administrador cambió un precio entre la consulta del carrito y el pago, la respuesta es un error `PRICE_CHANGED` con `extensions.newQuote`; se repite `checkoutCart` con `newQuote.quoteId` para aceptar el total nuevo.

### Asociar una imagen

```graphql
mutation Imagen($id: ID!, $input: ProductUpdateInput!) {
  updateProduct(id: $id, input: $input) {
    id
    name
    imageUrl
  }
}
```

Enviar en `input` un objeto con `imageUrl` igual a la URL pública real de la imagen. Para un paquete se usa `updatePackage` con `PackageUpdateInput`.

### Reportes

```graphql
query Analitica($from: DateTime!, $to: DateTime!) {
  salesReport(from: $from, to: $to) {
    type itemId name quantity revenue orderCount
  }
  packageComponentDemand(from: $from, to: $to) {
    productId name quantityNeeded packagesSold inPackages
  }
}
```

Variables:

```json
{
  "from": "2026-09-01T00:00:00.000Z",
  "to": "2026-09-30T23:59:59.999Z"
}
```

Los reportes pueden devolver arreglos vacíos si no existen pedidos en los estados y fechas correspondientes.

## 13. Alcance y consideraciones de mantenimiento

Esta versión contiene los elementos de Docker, dominio, Mongoose, GraphQL y agregación del núcleo documental, pero su presencia no equivale a una certificación de funcionamiento bajo carga o en producción.

Aspectos relevantes al continuar el desarrollo:

- La autenticación es JWT + sesión en Redis. No hay limitación de intentos de `login`, recuperación de contraseña ni cambio de contraseña, y tampoco una operación para desactivar usuarios o cambiar su rol; el rol del token vale hasta que expira o se hace `logout`.
- Las contraseñas se guardan con `scrypt` y sal aleatoria (`scrypt$sal$hash`). Con el registro abierto (`createUser` sin sesión) cualquiera puede crear cuentas `CUSTOMER`.
- Sin Redis nadie puede iniciar sesión ni usar un token existente (falla cerrado); el catálogo público sigue disponible.
- El caché es de lectura. Las copias de producto pueden mostrar datos de hasta `CACHE_TTL_PRODUCT` segundos de antigüedad si MongoDB se modifica por fuera de la API; las compras siempre usan MongoDB. El caché y las sesiones asumen un solo proceso de mongoAPI.
- El stock es global por producto (no por sucursal). El descuento de stock al comprar es atómico por producto pero no es una transacción multidocumento junto con la orden.
- La idempotencia no compara el contenido de solicitudes repetidas.
- Las cantidades son enteras: no se puede pedir medio kilo de un producto vendido por `KG`.
- La selección de campos GraphQL no evita por sí sola consultas repetidas al resolver relaciones.
- No se incluyen pruebas automatizadas ni un script `test` en los paquetes actuales. Los ejemplos de este README son procedimientos de uso, no evidencia de pruebas ejecutadas.

Para cambiar estas conductas debe modificarse la implementación y mantenerse sincronizada la documentación. Este README no altera modelos, operaciones, datos ni infraestructura.
