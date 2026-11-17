# PickarooAPI

Backend GraphQL de Pickaroo, un **marketplace**: cada sucursal (`Store`) es un negocio independiente con su propio catálogo de productos y paquetes, su stock y su política de reparto; las categorías son globales y las comparten todas. La API administra el catálogo de cada sucursal, usuarios, listas de compra y pedidos con recogida o entrega a domicilio, siempre de una sola sucursal por carrito y por pedido. La implementación incluye datos de demostración de dos negocios: CARNYFRUT Centro (productos para carne asada y parrilladas) y Frutería La Huerta.

El componente principal es **`services/mongoAPI`**: contiene las reglas de negocio, los modelos documentales de MongoDB y las operaciones de la API. **Apollo Gateway** publica un punto de entrada unificado, **Redis Stack** guarda las sesiones de inicio de sesión (JWT), el carrito y una copia de lectura de productos y usuarios. **Neo4j** guarda el grafo de roles, permisos, sucursales del personal y menús (RBAC). Cada acción relevante se publica en **RabbitMQ** y **`services/auditAPI`** la persiste en **ScyllaDB** como bitácora de auditoría inmutable.


## 1. Arquitectura y componentes

```mermaid
flowchart LR
  Cliente[Cliente GraphQL] --> Gateway[Apollo Gateway\nlocalhost:4000]
  Gateway --> API[mongoAPI\nlocalhost:4001]
  API --> Dominio[Reglas de dominio\ndomain/entities.js]
  API --> Mongoose[Modelos Mongoose]
  Mongoose --> Mongo[(MongoDB\nDocker:27017)]
  API --> Redis[(Redis Stack\nDocker:6379)]
  API --> Neo4j[(Neo4j\nDocker:7687)]
  API -- eventos --> Rabbit[RabbitMQ\nDocker:5672]
  Rabbit --> Audit[auditAPI\nlocalhost:4003]
  Gateway --> Audit
  Audit --> Scylla[(ScyllaDB\nDocker:9042)]
```

| Componente | Responsabilidad |
|---|---|
| Apollo Gateway | Componer los subgrafos `pickaroo` y `auditoria`, y reenviarles el JWT, la IP y el User-Agent del cliente. |
| mongoAPI | Ejecutar consultas y mutaciones, coordinar validaciones, persistir documentos y publicar eventos. |
| Dominio | Encapsular reglas de productos, paquetes, inventario, precios, descuentos, entrega y estados de pedidos. |
| Mongoose | Definir tipos, restricciones, subdocumentos, referencias e índices de MongoDB. |
| MongoDB | Almacenar las colecciones del negocio y ejecutar los pipelines analíticos. |
| Redis Stack | Sesiones activas del JWT (con sus permisos), carrito, cotizaciones y caché de lectura (Redis OM) de productos y usuarios. |
| Neo4j | Roles, herencia de roles, permisos, sucursales asignadas al personal y menú de navegación (RBAC). |
| RabbitMQ | Cola durable `pickaroo.events` con los eventos de auditoría que publica mongoAPI. |
| auditAPI | Consumir la cola, escribir la bitácora en ScyllaDB y exponer sus consultas (permiso `audit:view`). |
| ScyllaDB | Bitácora inmutable de seguridad, administración, catálogo y órdenes. |

El Gateway, mongoAPI y auditAPI son procesos Node.js ejecutados en el equipo anfitrión. El archivo Compose levanta MongoDB, RabbitMQ, Redis Stack, Neo4j y ScyllaDB, no los procesos Node.js.

El plan de diseño de roles y bitácora está en [docs/PLAN-neo4j-scylladb.md](docs/PLAN-neo4j-scylladb.md).

### Estructura del repositorio

```text
PickarooAPI/
├── README.md
├── package.json
├── docker-compose.yml
├── schema/
│   └── api.graphql               esquema para clientes (generado, no editar)
├── scripts/
│   ├── package.json
│   └── build-schema.js           npm run schema:build / schema:check
├── test/
│   └── integration/              npm run test:integration (contra el Compose)
├── docs/
│   └── PLAN-neo4j-scylladb.md
├── gateway/
│   ├── package.json
│   ├── .env.example
│   └── index.js
└── services/
    ├── auditAPI/                 bitácora: RabbitMQ → ScyllaDB + consultas GraphQL
    │   ├── package.json
    │   ├── .env.example
    │   └── src/
    │       ├── index.js
    │       ├── schema.graphql
    │       ├── auth.js           JWT + sesión de Redis (permiso audit:view)
    │       ├── consumer.js       consumidor de RabbitMQ
    │       └── scylla.js         keyspace, tablas y consultas CQL
    └── mongoAPI/
        ├── package.json
        ├── .env.example
        └── src/
            ├── index.js
            ├── migrate.js        npm run migrate (migraciones sin arrancar la API)
            ├── auth.js
            ├── schema.graphql
            ├── domain/
            │   ├── entities.js
            │   ├── errors.js     catálogo de códigos de error y DomainError
            │   ├── access.js     roles, permisos, menús y reglas de acceso
            │   ├── refresh-tokens.js  forma, hash y vencimiento de los refresh tokens
            │   └── migrations.js decisiones puras de las migraciones de datos
            └── infrastructure/
                ├── neo4j.js
                ├── migrations.js migraciones de datos (MongoDB)
                ├── rbac-graph.js consultas Cypher del RBAC
                ├── events.js     productor de eventos de auditoría
                ├── format-error.js  errores de dominio/Mongoose → extensions.code
                ├── redis-om.js
                ├── entity-cache.js
                ├── cart-store.js
                ├── quote-store.js
                ├── refresh-store.js  refresh tokens en Redis (rotación y revocación atómicas, Lua)
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
- `UserRole`: `CUSTOMER`, `STAFF`, `DELIVERY`, `MANAGER` y `ADMIN`.
- `OrderStatus`: estados del ciclo de vida del pedido.

Los importes se exponen como `Float` en **pesos mexicanos**, no como centavos enteros. Las cantidades de carrito, paquete y stock son enteros; por ejemplo, `quantity: 2` de un producto con `unit: KG` representa dos kilogramos. El contrato actual no admite `quantity: 0.5`.

### Dominio: `src/domain/entities.js`

La capa de dominio no importa Mongoose ni Apollo. Sus clases `Product` y `Package` (con el `storeId` de su sucursal) y sus funciones centralizan las siguientes reglas:

| Elemento | Función |
|---|---|
| `assertProductPersistable` | Exigir nombre válido, precio positivo y stock entero no negativo. |
| `assertPackagePersistable` | Exigir nombre, precio positivo y entre 2 y 40 productos distintos con cantidades enteras positivas. |
| `assertPackageSameStore` | Exigir que todos los productos de un paquete sean de su sucursal (`PACKAGE_STORE_MISMATCH`). |
| `linesStoreId` | Obtener la sucursal de una cotización u orden a partir de sus partidas (`MIXED_STORES`, `STORE_MISMATCH`, `ITEM_WITHOUT_STORE`). |
| `cartStoreId` / `assertCartAccepts` | Obtener la sucursal de un carrito y rechazar artículos de otra (`CART_STORE_MISMATCH`). |
| `Package.availableStock` | Calcular cuántos paquetes completos alcanzan con el stock de sus productos. |
| `Package.alaCarteTotal` / `savings` | Comparar el precio fijo del paquete con su contenido comprado por separado. |
| `stockDemand` | Sumar cuánto de cada producto consume una compra, sea suelto o dentro de paquetes. |
| `bestDiscountPercent` | Seleccionar el mayor porcentaje entre los descuentos vigentes. |
| `applyDiscount` | Calcular el precio unitario después del descuento. |
| `priceOrder` | Construir las partidas históricas, validar stock consolidado y calcular subtotal, descuento, envío y total. |
| `deliveryFee` | Determinar el costo de entrega según la sucursal de los artículos y su umbral de envío gratuito. |
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
4. Ejecuta las migraciones de datos (idempotentes, ver "Migración al marketplace" en la sección 3). Un fallo se registra y no detiene el arranque.
5. Conecta con Redis (espera hasta 3 segundos; si no responde, sigue reintentando en segundo plano).
6. Conecta con Neo4j y crea/actualiza el catálogo RBAC y las sucursales; si no responde, reintenta cada 10 segundos.
7. Intenta conectar con RabbitMQ y declarar la cola de eventos.
8. Construye y publica el subgrafo con Apollo Server; el contexto de cada petición valida el JWT.
9. Si `SEED=true`, ejecuta la carga de demostración después de que el servidor empieza a escuchar (siempre después de las migraciones).

`syncIndexes()` puede crear o eliminar índices para alinearlos con los esquemas. El inicio del servicio no es, por tanto, una operación estrictamente de solo lectura sobre la base.

### Redis: caché de lectura y sesiones

MongoDB sigue siendo la fuente de verdad. Redis Stack (RedisJSON + RediSearch) se usa de dos formas:

| Uso | Claves | TTL | Archivo |
|---|---|---|---|
| Sesiones del JWT | `session:<jti>` (JSON: usuario, rol, permisos, sucursales) | `JWT_TTL_SECONDS` (3600) | `auth.js` |
| Índice de sesiones | `user:<userId>:sessions` (SET de `jti`) | igual que la sesión | `auth.js` |
| Refresh tokens | `refresh:<hash>` (JSON: `userId`, `familyId`, `createdAt`, `expiresAt`); `<hash>` es el SHA-256 del token, que nunca se guarda | `REFRESH_TTL_SECONDS` (30 días), completo en cada canje | `refresh-store.js` |
| Refresh tokens ya canjeados | `refresh:spent:<hash>` (JSON: `familyId`, `userId`) | `REFRESH_TTL_SECONDS` desde el canje (lo que le queda a la familia) | `refresh-store.js` |
| Ventana de gracia de un canje | `refresh:grace:<hash>` (JSON: `userId`, `familyId`, `jti`, `iat`, `nonce`); ni el token canjeado ni su sucesor | `REFRESH_REUSE_GRACE_SECONDS` (10 s) | `refresh-store.js` |
| Familia (un dispositivo) | `refresh-family:<familyId>` (hash del token vigente) y `refresh-family:<familyId>:sessions` (SET de `jti` que abrió la familia; cada canje quita hasta 10 de sesiones ya vencidas) | `REFRESH_TTL_SECONDS`, se renueva en cada canje | `refresh-store.js` |
| Índice de familias | `user:<userId>:refresh-families` (SET de `familyId`) | `REFRESH_TTL_SECONDS`, se renueva en cada login o canje | `refresh-store.js` |
| Caché de productos (Redis OM, JSON) | `Product:<id>` | 120 s (`CACHE_TTL_PRODUCT`) | `entity-cache.js` |
| Caché de usuarios (Redis OM, JSON) | `User:<id>` | 3600 s (`CACHE_TTL_USER`) | `entity-cache.js` |
| Carrito | `cart:<userId>` (HASH `p:<productId>` / `k:<packageId>` → cantidad; una sola sucursal, la de sus partidas) | 7 días, se renueva con cada cambio | `cart-store.js` |
| Cotizaciones | `quote:<uuid>` (JSON con partidas, envío y total) | 15 min | `quote-store.js` |
| Pedidos recientes | `user:<userId>:orders:recent` (LIST de ids, máx. 20) | 24 h | `recent-orders.js` |

#### Carrito y cotizaciones: precios que cambian y productos que desaparecen

- **El carrito no guarda precios**, solo ids y cantidades. Cada lectura (`cart`) lo contrasta con el catálogo actual de MongoDB (`reconcileCart` en el dominio). Un cambio de precio se ve al instante, y lo que ya no se puede comprar aparece en `unavailable` con su motivo (`DELETED`, `INACTIVE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `OTHER_STORE`) en lugar de cobrarse. Desactivar o borrar un producto no exige recorrer los carritos.
- **Un carrito es de una sola sucursal.** No se guarda aparte: es la de sus partidas (`Cart.store`, null si está vacío). `addToCart` (y `setCartItemQuantity` con una partida nueva) rechaza un artículo de otra sucursal con `CART_STORE_MISMATCH` (`cartStoreId`, `itemStoreId`); el cliente ofrece "vaciar el carrito y agregar" (`clearCart` y de nuevo `addToCart`). El argumento `storeId` de `cart` es solo una pista: si no es la sucursal del carrito, `STORE_MISMATCH`. Un carrito que ya mezclaba sucursales (anterior al marketplace) se queda con la sucursal de la pista o, sin pista, con la que tiene más partidas; las demás aparecen en `unavailable` con `OTHER_STORE`. La comprobación al agregar no es atómica entre dos peticiones simultáneas; si se colara una mezcla, la lectura la reporta como `OTHER_STORE`.
- **Una cotización y una orden son de una sola sucursal**: la de sus artículos. `QuoteInput.storeId`, `CreateOrderInput.storeId` y `CheckoutCartInput.storeId` son pistas opcionales: si no coinciden, `STORE_MISMATCH` (`expectedStoreId`, `itemsStoreId`); artículos de varias sucursales, `MIXED_STORES` (`storeIds`). El costo de envío y el umbral de envío gratis son los de esa sucursal.
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
- **Redis caído:** las lecturas siguen funcionando desde MongoDB; `login`, `refreshToken`, `assignRole`, `assignUserToStore` y `removeUserFromStore` responden `SERVICE_UNAVAILABLE` (`service: SESSIONS`) y los tokens existentes dejan de aceptarse hasta que Redis vuelva (las sesiones no se pueden verificar). Si Redis se cae a mitad de un canje, de `logout` o de `logoutAllDevices`, la respuesta también es `SERVICE_UNAVAILABLE` (`SESSIONS`), no un error interno: el cliente conserva su refresh token y reintenta. Al conectar (o reconectar) se vacían `Product:*` y `User:*` para no servir copias de cambios hechos mientras Redis o la app estaban caídos.
- `CACHE_DEBUG=true` imprime cada `HIT`, `MISS`, `SAVE` y `DEL`.

La interfaz **RedisInsight** (`http://localhost:8001`) permite inspeccionar estas claves.

### Autenticación: `src/auth.js`

Autenticación híbrida **JWT + sesión activa en Redis**:

1. `login(input: {email, password})` verifica la contraseña (scrypt, comparación en tiempo constante) y lee de Neo4j el rol, los permisos efectivos y las sucursales del usuario. Firma un JWT HS256 con `sub`, `name`, `email`, `role` y un `jti` único, y guarda `session:<jti>` en Redis con esos permisos y el mismo TTL. Devuelve también `access`, `menu` y un **refresh token** (`refreshToken`, `refreshExpiresIn`).
2. Cada petición envía `Authorization: Bearer <token>`. El Gateway reenvía el encabezado al subgrafo, que valida la firma y la expiración **y** que `session:<jti>` siga existiendo. Los permisos salen de la sesión: una petición no consulta Neo4j.
3. `logout` borra `session:<jti>`: el token deja de servir al instante, aunque no haya expirado.

Correo inexistente, contraseña incorrecta y cuenta desactivada devuelven el mismo mensaje (`Credenciales inválidas.`); el motivo real queda en la bitácora.

#### Refresh tokens: seguir con la sesión sin pedir la contraseña

El token de acceso dura una hora (`JWT_TTL_SECONDS`). Para no pedir la contraseña cada hora, `login` entrega además un refresh token que dura 30 días (`REFRESH_TTL_SECONDS`). Es la credencial que la app Android guarda cifrada detrás de la huella (inicio de sesión biométrico) y que "Olvidar este dispositivo" revoca en el servidor.

- **Opaco y de un solo uso.** Son 256 bits en base64url (43 caracteres), no un JWT: no lleva datos y solo sirve contra Redis. El del login es aleatorio; el de cada canje se deriva del canjeado (ver "Ventana de gracia"). Redis guarda únicamente su SHA-256 (`refresh:<hash>`); las búsquedas y comparaciones son por hash. El token nunca se registra en consola ni en la bitácora ni se cachea.
- **Familia.** Cada `login` empieza una familia: un inicio de sesión en un dispositivo, la cadena de tokens que se rotan a partir de él. `refresh-family:<familyId>` apunta al token vigente y `refresh-family:<familyId>:sessions` lista los `jti` de las sesiones que abrió. `user:<userId>:refresh-families` indexa las familias del usuario.
- **Rotación.** `refreshToken(token)` es pública (no lleva `Authorization`). Con un token vigente lo consume, entrega otro de la misma familia con 30 días completos (no los que le quedaban al anterior) y abre una sesión nueva igual que `login`: rol, permisos y sucursales se releen de Neo4j y el menú también. El token de acceso anterior sigue sirviendo hasta que vence o se cierra su sesión. Se registra `TOKEN_REFRESHED` (`familyId`, `jti` nuevo).
- **Ventana de gracia (`REFRESH_REUSE_GRACE_SECONDS`, 10 s; 0 la desactiva).** En una red móvil la respuesta de un canje puede perderse después de que el servidor rotó, y dos partes de la app pueden canjear el mismo token a la vez. Durante la ventana, presentar el token recién canjeado devuelve **el mismo resultado** que obtuvo el canje ganador: el mismo refresh token sucesor, el mismo token de acceso y la misma sesión (no se emite otro). Se registra `TOKEN_REFRESHED` con `metadata.grace: true`. Solo aplica mientras el sucesor siga vigente: si ya se canjeó (el token presentado tiene dos rotaciones de atraso) o la familia se revocó, el caso sigue como se describe abajo.
  - *Cómo se reentrega sin guardar el sucesor.* El sucesor no es aleatorio puro: es `HMAC-SHA256(clave = token canjeado, nonce)`, con un nonce aleatorio de 256 bits. El mismo script Lua que rota escribe `refresh:grace:<hash del canjeado>` con lo mínimo para repetir el resultado (`userId`, `familyId`, el `jti` de la sesión, el `iat` de su JWT y el nonce), con TTL igual a la ventana. En el reintento el servidor recalcula el sucesor con el token presentado y el nonce, comprueba que siga siendo el vigente de la familia y vuelve a firmar el JWT con el mismo `jti` e `iat` (HS256 es determinista: sale el mismo token). Alternativa descartada: guardar el sucesor en claro durante la ventana; quien leyera Redis (RedisInsight, un volcado RDB) se llevaría un refresh token vigente.
  - *Compromiso.* Quien tenga el token canjeado puede obtener el sucesor durante la ventana: es exactamente lo que la ventana concede (el servidor no distingue al dueño que reintenta de un ladrón tan rápido). Fuera de ella el nonce ya no existe y el token canjeado no sirve para calcular nada; Redis solo tiene hashes y el nonce, que sin el token canjeado (que Redis no guarda) no sirve. Pasada la ventana, presentarlo es reutilización. Si el nombre o el correo del usuario cambian dentro de la ventana, el JWT reentregado lleva los datos nuevos (sigue siendo de la misma sesión). `expiresIn` y `refreshExpiresIn` repiten los del ganador, unos segundos más largos que lo que de verdad queda.
- **Detección de reutilización.** Al rotar, el hash del token consumido queda marcado como usado (`refresh:spent:<hash>`, con la vida que le queda a la familia). Si alguien presenta un token ya usado fuera de la ventana de gracia y su familia sigue viva, el original fue copiado: se revoca **toda la familia** (el token vigente y todas las sesiones que abrió, la del login incluida), se responde `REFRESH_TOKEN_REUSED` y se registra `REFRESH_REUSED` (`SECURITY`, actor = el usuario del token, `metadata.familyId`; nunca el token). Si la familia ya no existe (`logout(refreshToken)`, `logoutAllDevices`, un cambio de acceso o una reutilización anterior), no hay nada que proteger: la respuesta es `INVALID_REFRESH_TOKEN` y solo se registra `REFRESH_FAILED`, sin alerta de robo.
- **Atomicidad.** Comprobar y rotar es un script Lua en Redis (`infrastructure/refresh-store.js`): Redis lo ejecuta completo sin intercalar otros comandos. Si dos canjes del mismo token llegan a la vez, exactamente uno lo consume; el otro encuentra la marca de usado y, dentro de la ventana de gracia, recibe el mismo resultado que el ganador (sin la ventana contaría como reutilización). El token nuevo, la sesión nueva y el registro de gracia se escriben en el mismo script, así una revocación posterior siempre los alcanza. El script también quita del conjunto `refresh-family:<familyId>:sessions` (y de `user:<userId>:sessions`) hasta 10 `jti` cuyas sesiones ya vencieron, para que no crezca sin límite con un costo fijo por canje. `GETDEL` no bastaba (consume, pero la marca de usado se escribiría en otro paso y el perdedor podría leer "desconocido") y `WATCH/MULTI` exige una conexión aislada y reintentos. La revocación también es un script Lua. Los scripts arman claves a partir de lo que leen: sirven en el Redis de una instancia del Compose, no en Redis Cluster.
- **Token desconocido, vencido o revocado, de una familia que ya no existe, o cuenta desactivada:** `INVALID_REFRESH_TOKEN` (no se distingue a propósito, como `INVALID_CREDENTIALS`); el motivo real queda en la bitácora como `REFRESH_FAILED`.
- **Servicios caídos durante el canje:** sin Redis (o si falla a mitad), `SERVICE_UNAVAILABLE` con `service: SESSIONS`. Sin Neo4j la sesión nueva saldría sin permisos, así que el canje se rechaza **antes de rotar** con `SERVICE_UNAVAILABLE` y `service: RBAC` (se registra `RBAC_UNAVAILABLE`): el token sigue sin gastar y el cliente reintenta con el mismo. El `login` con Neo4j caído sí entra con permisos vacíos (ver "Neo4j caído").
- **Cerrar sesión en un dispositivo:** `logout(refreshToken: "…")` borra la sesión actual y, si el refresh token es del mismo usuario, revoca su familia completa (token y sesiones): es "Olvidar este dispositivo" y la salida total. Sirve el token vigente o uno ya canjeado de la familia (la familia se encuentra por la marca de usado), por si el cliente se quedó con el anterior. Un token ajeno o desconocido se ignora; `logout` sin argumento solo cierra la sesión actual y deja vivo el refresh token (la app lo conserva para entrar con la huella).
- **Cerrar sesión en todos los dispositivos:** `logoutAllDevices` (requiere sesión) revoca todas las familias y todas las sesiones del usuario y registra `SESSIONS_REVOKED` (`SECURITY`).
- **Cambios de acceso:** `assignRole`, `assignUserToStore` y `removeUserFromStore` revocan, además de las sesiones, todas las familias del usuario: un refresh no puede revivir los permisos anteriores. Ver "Cambios de acceso inmediatos" para lo que pasa si Redis no responde.

Qué esperar de `refreshToken`:

| Caso | Respuesta |
|---|---|
| Token vigente | `AuthPayload` nuevo (otro refresh token y otra sesión) |
| Reintento con el token recién canjeado, dentro de la ventana de gracia y con el sucesor sin canjear | El mismo `AuthPayload` que recibió el canje anterior |
| Token ya canjeado, fuera de la ventana (o con el sucesor ya canjeado), de una familia viva | `REFRESH_TOKEN_REUSED` (se revoca la familia) |
| Token ya canjeado de una familia revocada (cierre de sesión, cambio de acceso, reutilización anterior) | `INVALID_REFRESH_TOKEN` |
| Token desconocido, mal formado, vencido o revocado; cuenta desactivada | `INVALID_REFRESH_TOKEN` |
| Redis no disponible o falla a mitad del canje | `SERVICE_UNAVAILABLE`, `service: SESSIONS` (el token no se gasta, salvo que la rotación ya se haya hecho: entonces el reintento cae en la ventana de gracia) |
| Neo4j no disponible | `SERVICE_UNAVAILABLE`, `service: RBAC` (el token no se gasta) |

Qué deben hacer los clientes (Android y dashboard):

1. Guardar el refresh token de forma segura (Android: cifrado con Android Keystore; detrás de la huella si el usuario activó el inicio biométrico) y reemplazarlo por el nuevo después de **cada** canje: el anterior deja de servir al terminar la ventana de gracia y presentarlo después cierra la sesión del dispositivo.
2. Ante `UNAUTHENTICATED`, llamar a `refreshToken` una vez, guardar el par nuevo y reintentar la operación **una sola vez**.
3. Si el canje no recibe respuesta (tiempo agotado, red caída), reintentarlo **con el mismo token** cuanto antes: dentro de la ventana de gracia el servidor devuelve el mismo resultado.
4. Con `SERVICE_UNAVAILABLE` (`SESSIONS` o `RBAC`): **conservar el token** y reintentar con espera creciente (*backoff*). No borrar nada ni mandar al login.
5. Con `INVALID_REFRESH_TOKEN` o `REFRESH_TOKEN_REUSED`: **borrar el token** (y el de acceso) e ir al login con contraseña. Lo mismo si el reintento de la operación vuelve a dar `UNAUTHENTICATED`.
6. Compartir un solo canje entre las peticiones que reciban `UNAUTHENTICATED` a la vez. La ventana de gracia tolera un canje doble, pero no encadenar canjes: si una parte ya canjeó el sucesor, el token viejo cuenta como reutilización.

### Autorización: roles en Neo4j (`domain/access.js`, `infrastructure/rbac-graph.js`)

```
(:User {id})-[:HAS_ROLE]->(:Role)-[:INHERITS]->(:Role)
(:Role)-[:HAS_PERMISSION]->(:Permission)
(:User)-[:WORKS_AT]->(:Store {id})
(:Role)-[:CAN_VIEW_MENU]->(:MenuItem)-[:NAVIGATES_TO]->(:Route)
```

| Rol | Hereda de | Para quién | Permisos propios |
|---|---|---|---|
| `CUSTOMER` | — | Cliente | ninguno (lo suyo se controla por dueño) |
| `STAFF` | CUSTOMER | Empleado de mostrador | `orders:prepare`, `stock:manage` (en sus sucursales) |
| `DELIVERY` | CUSTOMER | Repartidor | `orders:deliver` |
| `MANAGER` | STAFF | Gerente de sucursal | `catalog:manage`, `reports:view` (en sus sucursales) |
| `ADMIN` | MANAGER | Dueño / sistemas | `orders:deliver`, `stores:manage`, `users:manage`, `audit:view`, `scope:all_stores` |

Los permisos efectivos son los del rol más los de todos los roles que hereda (`[:INHERITS*0..]`). Los `id` de `User` y `Store` en Neo4j son los `_id` de MongoDB.

- **Fuente de verdad:** Neo4j. `users.role` en MongoDB es un espejo: se actualiza con `assignRole` y se corrige solo en el login si difiere.
- **Catálogo:** roles, permisos, herencia y menú se definen en `domain/access.js` y se crean/actualizan en Neo4j en cada arranque (y al reconectar).
- **Auto-reparación:** un usuario que aún no está en el grafo se crea en su primer login con el rol espejo de MongoDB.
- **Alcance por sucursal:** el personal (`STAFF`, `DELIVERY`, `MANAGER`) solo ve y mueve órdenes de las sucursales con `WORKS_AT` (el repartidor, además, solo las disponibles para aceptar y las asignadas a él; ver sección 6, "Reparto"); `scope:all_stores` (ADMIN) ve todas. Lo mismo vale para el catálogo y el inventario: `catalog:manage` (alta y edición de productos y paquetes, descuentos, activar/desactivar) y `stock:manage` (`setProductStock`) solo aplican a artículos de una sucursal del alcance, y los reportes solo cubren esas sucursales. Fuera del alcance: `FORBIDDEN` con `reason: STORE_NOT_ASSIGNED` y `storeId`. La regla es `storeItemDenial` en `domain/access.js` (reportes: `reportStoreScope`).
- **Categorías globales:** las comparten todas las sucursales, así que crearlas exige `catalog:manage` **y** `scope:all_stores` (solo ADMIN). A un MANAGER le falta el segundo: `FORBIDDEN`, `reason: PERMISSION_REQUIRED`, `permission: scope:all_stores`.
- **Cambios de acceso inmediatos:** `assignRole`, `assignUserToStore` y `removeUserFromStore` revocan todas las sesiones del usuario (`user:<id>:sessions`) y todos sus refresh tokens (`user:<id>:refresh-families`); al volver a entrar recibe los permisos nuevos. Si Redis no está listo, la operación responde `SERVICE_UNAVAILABLE` (`service: SESSIONS`) **antes** de cambiar nada en Neo4j o MongoDB. Si Redis falla después de aplicar el cambio (entre el cambio y la revocación), la respuesta también es `SERVICE_UNAVAILABLE` (`SESSIONS`), pero el cambio queda hecho y registrado (`ROLE_CHANGED` o `STORE_ASSIGNMENT_CHANGED` se emiten antes de revocar): las sesiones abiertas conservan los permisos anteriores hasta vencer (`JWT_TTL_SECONDS`, una hora), y sus refresh tokens siguen vivos, pero el siguiente canje ya relee el acceso nuevo de Neo4j, así que no revive los permisos anteriores. Para terminar la revocación se repite la operación cuando Redis vuelva (`assignRole` y `assignUserToStore` se pueden repetir; `removeUserFromStore` responde `USER_NOT_ASSIGNED_TO_STORE`, así que en ese caso se usa `assignRole` con el mismo rol).
- **Neo4j caído:** el login funciona con permisos vacíos (`access.degraded = true`) y se registra `RBAC_UNAVAILABLE`. Nadie gana privilegios sin el grafo; los clientes compran normalmente. `refreshToken`, en cambio, responde `SERVICE_UNAVAILABLE` (`service: RBAC`) sin gastar el token, para que la sesión renovada no quede sin permisos.

Reglas de órdenes (`canChangeOrderStatus`):

| Transición | Permiso | Además |
|---|---|---|
| → `CONFIRMED`, `PREPARING`, `READY` | `orders:prepare` | sucursal asignada |
| `READY` → `DELIVERED` (PICKUP) | `orders:prepare` | sucursal asignada |
| `READY` → `IN_DELIVERY` → `DELIVERED` (DELIVERY) | `orders:deliver` | **ser el repartidor asignado** (`acceptDelivery`), o ADMIN si la orden ya tiene repartidor; una orden PICKUP nunca sale a reparto y una DELIVERY no se salta `IN_DELIVERY` |
| → `CANCELLED` | dueño de la orden, o `orders:prepare` | sucursal asignada; no depende del repartidor |

En una orden DELIVERY, recogerla (`READY → IN_DELIVERY`) y entregarla (`IN_DELIVERY → DELIVERED`) son pasos **del repartidor asignado** (`order.driverId`), mientras siga teniendo `orders:deliver`; no se le exige la sucursal, así que si lo cambian de sucursal con una entrega en curso la puede terminar. **Invariante: una orden `IN_DELIVERY` siempre tiene repartidor.** Por eso recogerla sin repartidor da `NO_DRIVER_ASSIGNED` a todos, ADMIN incluido: ADMIN tiene `orders:deliver` y la acepta él primero. ADMIN (`orders:deliver` + `scope:all_stores`) sí puede recoger o entregar una orden asignada a otro repartidor (el repartidor sigue en `driver` y queda libre al entregarla). Otro repartidor o el personal de mostrador de la sucursal reciben `FORBIDDEN` con `reason: NOT_ASSIGNED_DRIVER`, o `NO_DRIVER_ASSIGNED` si nadie la ha aceptado. Quien no es de la sucursal recibe `ORDER_STATUS_CHANGE_DENIED`, sin enterarse de la asignación. `READY → DELIVERED` en una orden DELIVERY no es un paso de la ruta: el repartidor y ADMIN reciben `INVALID_STATUS_TRANSITION` y el personal de mostrador, sin `orders:deliver`, `ORDER_STATUS_CHANGE_DENIED`. La regla es pura (`orderStatusDenial` en `domain/access.js`; `canChangeOrderStatus` es `orderStatusDenial(...) === null`) y `changeOrderStatus` la vuelve a evaluar en cada reintento.

Permisos por operación (errores `UNAUTHENTICATED` sin sesión y `FORBIDDEN` sin permiso):

| Acceso | Operaciones |
|---|---|
| Público | `login`, `refreshToken`, `createUser` (registro; siempre `CUSTOMER`), `categories`, `category`, `products`, `product`, `packages`, `package`, `stores`, `store`, `quoteOrder` |
| Sesión iniciada | `me`, `myAccess`, `myMenu`, `logout`, `logoutAllDevices`, `cart`, `addToCart`, `setCartItemQuantity`, `removeFromCart`, `clearCart`, `checkoutCart`, `recentOrders` |
| Dueño o `users:manage` | `user`, `addUserAddress`, `setDefaultAddress`, `removeUserAddress`, `createOrder`, `shoppingLists`, `shoppingList`, `createShoppingList`, `addItemToShoppingList`, `removeItemFromShoppingList`, `deleteShoppingList` |
| Dueño o personal de la sucursal | `order`, `orderByNumber`, `orders` (cliente: las suyas; personal de mostrador: las de sus sucursales; repartidor: las disponibles para aceptar de sus sucursales y las asignadas a él), `cancelOrder`, `updateOrderStatus` (según la tabla anterior) |
| `orders:deliver` (sucursales del alcance) | `availableDeliveries`, `acceptDelivery`, `myDeliveries`, `currentDelivery` |
| Repartidor asignado, `orders:prepare` en la sucursal o ADMIN | `releaseDelivery` |
| `stock:manage` en la sucursal del producto | `setProductStock` |
| `catalog:manage` en la sucursal del artículo (alta: la `storeId` del input) | `createProduct`, `updateProduct`, `setProductActive`, `addProductDiscount`, `removeProductDiscount`, `createPackage`, `updatePackage`, `setPackageActive` |
| `catalog:manage` + `scope:all_stores` | `createCategory` |
| `reports:view` (sucursales del alcance) | `salesReport`, `packageComponentDemand` |
| `stores:manage` | `createStore`, `updateStore` |
| `users:manage` | `users`, `roles`, `userAccess`, `assignRole`, `assignUserToStore`, `removeUserFromStore`, `createUser` con un rol distinto de `CUSTOMER` |
| `audit:view` | `auditEvents`, `auditByActor`, `auditByTarget`, `auditSummary` (subgrafo auditoria) |

La interfaz **Neo4j Browser** (`http://localhost:7474`, usuario `neo4j`) permite ver el grafo, por ejemplo con `MATCH (u:User)-[r]->(n) RETURN u, r, n`.

### Códigos de error y contrato de traducción

Los clientes (Android y dashboard, en español e inglés) **traducen por `extensions.code`** y por los datos estructurados de `extensions`; nunca muestran el `message`. El `message` va en español y sirve para la bitácora de auditoría y para Apollo Sandbox, no es parte del contrato. Cada código nombra una regla (no una redacción) y no cambia de nombre; las reglas nuevas añaden códigos nuevos. El catálogo vive en `services/mongoAPI/src/domain/errors.js` y una prueba estática (`test/domain/error-guard.test.js`) impide lanzar errores sin código o con un código fuera del catálogo.

Los campos de `extensions` están en camelCase y los marcados con `?` son opcionales. Ejemplo: `INSUFFICIENT_STOCK` llega con `{ code, productId, name, requested, available }`, con lo que el cliente arma la frase en su idioma.

**Sesión y permisos**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `UNAUTHENTICATED` | La operación requiere una sesión iniciada (falta el token o ya no es válido). | — |
| `FORBIDDEN` | Hay sesión, pero no permiso para la operación o el recurso. `reason` indica cuál regla (ver FORBIDDEN_REASONS). | `reason`, `permission?`, `storeId?`, `status?` |
| `INVALID_CREDENTIALS` | Correo o contraseña incorrectos, o cuenta desactivada (no se distingue a propósito). | — |
| `INVALID_REFRESH_TOKEN` | El refresh token no existe, venció, fue revocado, es de una familia ya cerrada o su cuenta está desactivada (no se distingue a propósito); hay que iniciar sesión con la contraseña. | — |
| `REFRESH_TOKEN_REUSED` | Se presentó un refresh token ya canjeado fuera de la ventana de gracia (posible robo): se revocó su familia completa (el token vigente y sus sesiones); hay que iniciar sesión con la contraseña. | — |
| `SERVICE_UNAVAILABLE` | Un servicio de apoyo no responde (sesiones, carrito, roles o bitácora); conviene reintentar. | `service?` |

**Validación y datos**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `VALIDATION_ERROR` | Falló la validación del modelo (Mongoose). `field` es el primer campo con error y `violations` los lista todos como [{ field, rule }]. | `field?`, `violations` |
| `NOT_FOUND` | La entidad referenciada no existe. | `entity`, `id` |
| `DUPLICATE_VALUE` | Ya existe un registro con ese valor único. | `field?` |
| `EMAIL_ALREADY_REGISTERED` | Ya hay un usuario registrado con ese correo. | `field` |
| `PASSWORD_TOO_SHORT` | La contraseña es más corta que el mínimo. | `minLength` |
| `INVALID_NAME` | El nombre del producto o paquete tiene menos del mínimo de caracteres. | `entity`, `minLength` |
| `INVALID_PRICE` | El precio del producto o paquete no es un número positivo. | `entity` |
| `INVALID_STOCK` | El stock no es un entero no negativo. | — |
| `INVALID_QUANTITY` | La cantidad no es un entero positivo (o excede el máximo del carrito). `context` indica dónde. | `context`, `min?`, `max?` |
| `INVALID_DAY_FORMAT` | El día de la consulta de auditoría no tiene el formato YYYY-MM-DD. | `field` |

**Paquetes**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `PACKAGE_SIZE_OUT_OF_RANGE` | El paquete tiene menos productos que el mínimo o más que el máximo. | `count`, `min`, `max` |
| `INVALID_PACKAGE_ITEM` | Un producto del paquete no trae productId. | — |
| `DUPLICATE_PACKAGE_PRODUCT` | El paquete repite un producto. | — |
| `PACKAGE_PRODUCT_NOT_FOUND` | Algún producto del paquete no existe en el catálogo. | — |
| `PACKAGE_STORE_MISMATCH` | Un paquete solo puede contener productos de su propia sucursal (`storeId`); `productIds` son los de otra. | `storeId`, `productIds` |

**Disponibilidad e inventario**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `ITEM_UNAVAILABLE` | El producto o paquete está desactivado (o, en un paquete, alguno de sus productos lo está). | `itemType`, `id?`, `name`, `componentId?`, `componentName?` |
| `INSUFFICIENT_STOCK` | No alcanza el stock de un producto para la cantidad pedida. | `productId`, `name`, `requested`, `available` |
| `ITEM_WITHOUT_STORE` | El producto o paquete no pertenece a ninguna sucursal (dato anterior al marketplace sin migrar); no se puede comprar. | `itemType`, `id`, `name` |

**Carrito**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `INVALID_CART_LINE` | Una partida debe indicar productId o packageId, uno solo. | — |
| `CART_FULL` | El carrito ya tiene el máximo de partidas. | `maxLines` |
| `CART_EMPTY` | El carrito está vacío. | — |
| `CART_HAS_UNAVAILABLE_ITEMS` | Hay partidas del carrito que ya no se pueden comprar. | `unavailable` |
| `CART_STORE_MISMATCH` | El carrito ya tiene artículos de otra sucursal (`cartStoreId`); para agregar este (de `itemStoreId`) hay que vaciarlo primero. | `cartStoreId`, `itemStoreId` |

**Cotización y compra**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `QUOTE_EXPIRED` | La cotización expiró o no existe; hay que reconfirmar. | `newQuote` |
| `QUOTE_MISMATCH` | La compra ya no coincide con la cotización (productos, cantidades, sucursal o modo). | `newQuote` |
| `PRICE_CHANGED` | Los precios cambiaron desde la cotización; hay que confirmar el total nuevo. | `newQuote` |
| `INVALID_ORDER_MODE` | El modo de la orden no es PICKUP ni DELIVERY. | `mode` |
| `EMPTY_ORDER` | La orden no tiene productos. | — |
| `STORE_REQUIRED` | Una orden de recogida necesita sucursal. | — |
| `DELIVERY_ADDRESS_REQUIRED` | Una orden a domicilio necesita dirección de entrega. | — |
| `USER_INACTIVE` | El usuario que compra está desactivado. | — |
| `STORE_INACTIVE` | La sucursal de los artículos está desactivada. | `storeId`, `name` |
| `STORE_MISMATCH` | La sucursal indicada (`expectedStoreId`) no es la de los artículos (`itemsStoreId`): la compra es de la sucursal de sus artículos. | `expectedStoreId`, `itemsStoreId` |
| `MIXED_STORES` | La compra tiene artículos de más de una sucursal (`storeIds`, ordenados). | `storeIds` |

**Estados de la orden**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `INVALID_ORDER_STATUS` | El estado indicado no existe. | `status` |
| `ORDER_ALREADY_IN_STATUS` | La orden ya está en el estado pedido. | `status` |
| `INVALID_STATUS_TRANSITION` | La transición de estado no está permitida. | `from`, `to` |
| `PICKUP_CANNOT_BE_DELIVERED` | Una orden de recogida (PICKUP) no puede salir a reparto. | — |

**Reparto**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `ORDER_NOT_AVAILABLE` | La orden no se puede aceptar ni liberar. `reason`: `TAKEN` (ya tiene repartidor), `NOT_READY` (aún no está lista), `PICKED_UP` (ya salió a reparto), `NOT_DELIVERY` (es de recogida), `CANCELLED` o `DELIVERED`. | `orderId`, `reason` |
| `ALREADY_DELIVERING` | El repartidor ya tiene una entrega activa (`activeOrderId`, READY o IN_DELIVERY asignada a él); solo puede llevar una a la vez. | `activeOrderId` |

**Roles y sucursales de usuarios**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `UNKNOWN_ROLE` | El rol indicado no existe. | `role` |
| `ROLE_GRAPH_NODE_NOT_FOUND` | El usuario o la sucursal no existen en el grafo de roles (Neo4j). | `userId`, `storeId?` |
| `USER_NOT_ASSIGNED_TO_STORE` | El usuario no está asignado a esa sucursal. | `userId`, `storeId` |

**Generados por Apollo Server**

| Código | Significado | Campos de `extensions` |
|---|---|---|
| `INTERNAL_SERVER_ERROR` | Error inesperado del servidor (no es una regla de negocio). | — |
| `BAD_USER_INPUT` | Una variable o argumento no tiene un valor válido para su tipo (p. ej. un DateTime mal formado). | — |
| `GRAPHQL_VALIDATION_FAILED` | La consulta no valida contra el esquema. | — |
| `GRAPHQL_PARSE_FAILED` | La consulta no se puede interpretar como GraphQL. | — |

Notas por código:

- `FORBIDDEN` conserva su código para todas las denegaciones porque el plugin de auditoría registra los accesos denegados (`ACCESS_DENIED`) por `UNAUTHENTICATED` y `FORBIDDEN`; la regla concreta va en `extensions.reason`:

| `reason` | Significado |
|---|---|
| `PERMISSION_REQUIRED` | Falta el permiso `permission` para la operación. |
| `NOT_RESOURCE_OWNER` | El recurso es de otro usuario y no se tiene users:manage. |
| `ORDER_VIEW_DENIED` | No se puede ver esa orden. |
| `ORDER_STATUS_CHANGE_DENIED` | No se puede pasar la orden al estado `status`. |
| `ORDER_CANCEL_DENIED` | No se puede cancelar esa orden. |
| `STORE_NOT_ASSIGNED` | La sucursal `storeId` no está asignada al usuario (órdenes, catálogo, inventario o reportes de otra sucursal). |
| `OWN_ORDERS_ONLY` | Solo se pueden consultar las órdenes propias. |
| `CANNOT_CHANGE_OWN_ROLE` | Un usuario no puede cambiar su propio rol. |
| `NOT_ASSIGNED_DRIVER` | La orden a domicilio tiene otro repartidor asignado: solo él (o ADMIN) la recoge y la entrega; liberarla pueden él, el personal de mostrador de la sucursal (`orders:prepare`) o ADMIN. Trae `status` en `updateOrderStatus`. |
| `NO_DRIVER_ASSIGNED` | La orden a domicilio no tiene repartidor asignado: primero hay que aceptarla (`acceptDelivery`). Trae `status` en `updateOrderStatus`. En el reintento de `releaseDelivery` de un repartidor significa que ya se liberó. |
| `OWN_ORDER` | Un repartidor no puede aceptar el reparto de una orden suya (`acceptDelivery`). |

- `INVALID_CREDENTIALS` cubre correo inexistente, contraseña incorrecta y cuenta desactivada con el mismo código a propósito. `UNAUTHENTICATED` queda para "no hay sesión válida": el cliente canjea su refresh token una vez y reintenta; si no tiene o el canje falla, va al login.
- `INVALID_REFRESH_TOKEN` y `REFRESH_TOKEN_REUSED` solo los devuelve `refreshToken`; en los dos casos el cliente borra los tokens guardados y va al login. `REFRESH_TOKEN_REUSED` indica que el token pudo haberse copiado (se presentó fuera de la ventana de gracia con su familia viva): la app puede avisar que se cerró la sesión de ese dispositivo por seguridad. Un token de una familia ya cerrada da `INVALID_REFRESH_TOKEN`, sin alerta. En cambio, ante `SERVICE_UNAVAILABLE` el cliente conserva el refresh token y reintenta con espera creciente.
- `NOT_FOUND.entity` es uno de `USER`, `STORE`, `ADDRESS`, `CATEGORY`, `PRODUCT`, `PACKAGE`, `DISCOUNT`, `ORDER` o `SHOPPING_LIST`; `ITEM_UNAVAILABLE.itemType`, `PRODUCT` o `PACKAGE`; `INVALID_NAME.entity` e `INVALID_PRICE.entity`, `PRODUCT` o `PACKAGE`; `INVALID_QUANTITY.context`, `ORDER_LINE`, `PACKAGE_ITEM` o `CART`; `SERVICE_UNAVAILABLE.service`, `SESSIONS`, `CART`, `RBAC` o `AUDIT_LOG`.
- `VALIDATION_ERROR` es la validación de Mongoose al guardar. `violations` es `[{ field, rule }]`; `rule` es el código de dominio cuando la regla viene del dominio (p. ej. `INVALID_PRICE`, `INVALID_STOCK`) o el tipo de Mongoose (`required`, `min`, `max`, `enum`, `user defined`…).
- Una clave única repetida (índice de MongoDB, error E11000) llega como `EMAIL_ALREADY_REGISTERED` si el campo es `email` y como `DUPLICATE_VALUE` con `field` en los demás casos.
- `QUOTE_EXPIRED`, `QUOTE_MISMATCH` y `PRICE_CHANGED` traen `newQuote` (`quoteId`, `expiresAt`, `subtotal`, `discountTotal`, `deliveryFee`, `total` e `items`) para reconfirmar sin otra consulta. `CART_HAS_UNAVAILABLE_ITEMS.unavailable` es `[{ productId, packageId, reason, availableQuantity }]` con `reason` en `DELETED`, `INACTIVE`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK` u `OTHER_STORE`.
- `ORDER_NOT_AVAILABLE` lo devuelven `acceptDelivery` (la orden no está en `READY` + `DELIVERY` + sin repartidor; `TAKEN` es el caso de dos repartidores que la aceptan a la vez) y `releaseDelivery` (la orden ya no está en `READY`: `PICKED_UP`, `CANCELLED`, `DELIVERED`…). La app muestra "ya no está disponible" y refresca la lista. `ALREADY_DELIVERING` solo lo devuelve `acceptDelivery`: la app lleva al repartidor a su entrega activa (`activeOrderId`). `activeOrderId` solo sería `null` si la entrega activa terminó justo entre el choque con el índice y su consulta, dos veces seguidas (no se ha visto en la práctica).
- Reintentar `releaseDelivery` tras perder la respuesta: si la primera llamada sí liberó la orden, el reintento del repartidor recibe `FORBIDDEN` con `NO_DRIVER_ASSIGNED` (la orden ya está libre) o `NOT_ASSIGNED_DRIVER` (otro repartidor ya la aceptó). En los dos casos la orden ya no es suya: la app lo trata como liberada. Para el personal de mostrador o ADMIN, el reintento sobre una orden libre devuelve la orden sin cambios.
- `NO_ACTIVE_STORE` ya no existe: la sucursal de una compra sale de sus artículos, nunca de "la primera sucursal activa".
- Limitación conocida: el campo `quoteError` del carrito (`Cart.quoteError`) es una cadena en español, no un código; el esquema no cambia en esta etapa.

## 3. Modelo documental

La aplicación exporta siete modelos. Cada dato vive en un solo lugar: lo que se puede derivar de otro dato (stock de un paquete, subtotal, descuento en pesos) se calcula en lugar de guardarse.

| Colección | Información principal | Datos incrustados o referencias |
|---|---|---|
| `users` | Nombre, correo, rol, estado, avatar y `defaultAddressId`. | `addresses[]`: hasta 25 direcciones con `_id`. |
| `categories` | Nombre (único, sin distinguir mayúsculas), icono y orden. **Globales**, compartidas por todas las sucursales. | Los productos la referencian mediante `categoryId`. |
| `products` | Sucursal (`storeId`), nombre, descripción, precio, imagen, unidad, stock y estado. | `discounts[]`: hasta 20 promociones. |
| `packages` | Sucursal (`storeId`), nombre, descripción, precio fijo, imagen y estado. **Sin stock propio.** | `items[]`: entre 2 y 40 productos de su sucursal con su cantidad. |
| `stores` | Nombre, contacto, horario y política de reparto. | `address`: ubicación incrustada. |
| `orders` | Número, usuario, sucursal, modalidad, estado, envío, total, notas y, en las DELIVERY aceptadas, repartidor (`driverId`) y `assignedAt`. | `items[]`: hasta 200 partidas; `deliveryAddress`: copia de la ubicación; `statusHistory[]`: hasta 20 cambios de estado (`status`, `at`, `byUserId`, `byRole`, `inferred`), solo se agrega. |
| `shopping_lists` | Usuario y nombre de la lista. | `items[]`: hasta 200 partidas de productos o paquetes. |

### Incrustación

Se utiliza cuando la información pertenece al documento principal, está acotada y se lee junto con él:

- Las direcciones están dentro de `users.addresses`; la predeterminada se indica con `users.defaultAddressId`.
- La dirección de una sucursal está en `stores.address`, con la misma forma (`street`, `city`, `state`, `zipCode`, `lat`, `lng`) que la de usuarios y que la copia de entrega de una orden.
- Los descuentos están dentro de `products.discounts`.
- El contenido de un paquete está dentro de `packages.items`.
- Las partidas están dentro de `orders.items` y `shopping_lists.items`.

### Referenciación

Las relaciones compartidas o sin límite de crecimiento se representan con `ObjectId`: la sucursal y la categoría de un producto, la sucursal y los productos de un paquete, el usuario y la sucursal de un pedido, y el producto **o** paquete de cada partida (`productId` o `packageId`, nunca ambos). El `storeId` de productos y paquetes es obligatorio e inmutable (`immutable` en Mongoose; los inputs de edición no lo traen).

Los pedidos se conservan en su propia colección para que el historial de un usuario crezca sin quedar incrustado en su documento. Una referencia Mongoose no es una clave foránea que MongoDB verifique automáticamente: la aplicación comprueba la existencia de entidades en distintas operaciones.

### Índices principales

- Correo de usuario único y nombre de categoría único (colación `es`, sin distinguir mayúsculas).
- Número de pedido único.
- Usuario y clave de idempotencia únicos cuando la clave es una cadena.
- Categoría y estado activo de productos, y sucursal + categoría + estado activo (catálogo de una sucursal); índice de texto sobre nombre y descripción.
- Sucursal y estado activo de paquetes; `packages.items.productId`, para saber qué paquetes contienen un producto.
- Pedidos por usuario, estado, fecha y sucursal; sucursal + estado + modalidad + repartidor + fecha (entregas disponibles); repartidor + estado + actualización (entregas de un repartidor).
- `one_active_delivery_per_driver`: `driverId` único entre los pedidos `READY` / `IN_DELIVERY` con repartidor (índice parcial). Es lo que garantiza una sola entrega activa por repartidor.
- Listas por usuario y fecha de actualización.

### Migración al marketplace

Antes del marketplace los productos y paquetes no tenían sucursal. La migración `backfillCatalogStores` (`infrastructure/migrations.js`; la decisión pura es `planCatalogStoreBackfill` en `domain/migrations.js`) asigna todo producto y paquete sin `storeId` a la **sucursal activa más antigua por `createdAt`** y registra cuántos cambió (`🧭 Migración storeId: productos N, paquetes M → "Sucursal"`).

- Corre en cada arranque de mongoAPI, después de `syncIndexes()` y antes del seed, y también sola con `npm run migrate` (usa el `MONGODB_URI` del `.env` de mongoAPI; no arranca la API).
- Es idempotente: una segunda corrida cambia 0 documentos.
- Si hay sucursales pero ninguna está activa, usa la más antigua y registra una advertencia: sus artículos quedan ocultos al público hasta reactivar esa sucursal.
- Si hay artículos sin sucursal y no existe ninguna sucursal, registra una advertencia y los deja así: no se listan (`products` y `packages` solo muestran artículos de sucursales activas) y no se pueden comprar (`ITEM_WITHOUT_STORE`) hasta crear una sucursal y volver a correrla.
- Las categorías no se migran: siguen siendo globales, incluidas las creadas a mano.

### Migración del historial de estados

Las órdenes anteriores a `statusHistory` no lo tienen. La migración `backfillStatusHistory` (`infrastructure/migrations.js`; la decisión pura es `planStatusHistoryBackfill` en `domain/migrations.js`) sintetiza, para cada orden sin historial (campo ausente o vacío), `PENDING` en `createdAt` y, si el estado actual no es `PENDING`, ese estado en `updatedAt` (la única fecha que se conservaba). Ambas entradas llevan `inferred: true` y no tienen autor (`byRole` y `by` nulos). Registra cuántas órdenes cambió (`🧭 Migración historial de estados: órdenes N`).

- Corre en cada arranque de mongoAPI junto con la anterior y también con `npm run migrate`.
- Es idempotente: cada escritura repite la condición "sin historial", así que una segunda corrida cambia 0 órdenes y una orden que cambió de estado durante la migración no se pisa.

## 4. Productos y paquetes

### Producto

Es una unidad vendible del catálogo **de una sucursal**, con precio, unidad (`UNIDAD`, `KG` o `LITRO`) y stock propios; como el stock vive en el producto, es de esa sucursal. `createProduct` exige `storeId` (una sucursal del alcance de quien lo da de alta), comprueba que exista la categoría y persiste el documento validado. `Product.store` devuelve la sucursal; `updateProduct` no la cambia.

### Catálogo por sucursal

- `products(storeId, categoryId, search, activeOnly, limit, offset)` y `packages(storeId, activeOnly)`: con `storeId`, el catálogo de esa sucursal; sin él, el de todas las sucursales activas (búsqueda del marketplace).
- `Store.products(categoryId, search, activeOnly, limit, offset)`, `Store.packages(activeOnly)` y `Store.categories` (categorías con al menos un producto activo en la sucursal) exponen el catálogo desde la sucursal.
- Los artículos de una sucursal desactivada nunca se listan al público (tampoco en `Category.products`); quien administra su catálogo o su inventario (`catalog:manage` o `stock:manage` en esa sucursal, o ADMIN) sí los ve con `storeId` o desde `Store`, igual que quien tiene `scope:all_stores`. Por id pasa lo mismo: `product(id)`, `package(id)`, `Product.packages` y los artículos de las listas guardadas dan `null` si son de una sucursal inactiva y quien consulta no la administra. Dentro de una orden ya hecha (`OrderItem.product`, `OrderItem.package` y su contenido) el artículo se sigue mostrando aunque la sucursal cierre, para no romper el historial.
- `activeOnly: false` (artículos desactivados, con su stock y precio) solo se respeta en las sucursales que quien consulta administra (`catalog:manage` o `stock:manage` en ellas) o en todas con `scope:all_stores`. Para cualquiera más se trata como `true`, en silencio y sin error. Sin `storeId`, quien administra solo algunas sucursales ve los artículos desactivados únicamente de esas.
- `addToCart` y `setCartItemQuantity` rechazan de inmediato un artículo de una sucursal inactiva con `STORE_INACTIVE`, sin esperar a la compra.

### Paquete

Un paquete (por ejemplo, el combo para carne asada) vive en su propia colección `packages` y es de una sucursal. Se crea con `createPackage`, indicando sucursal, nombre, precio y contenido; se edita con `updatePackage` (sin cambiar la sucursal) y se activa o desactiva con `setPackageActive`.

```javascript
items: [
  { productId: "ID_ARRACHERA", quantity: 2 },
  { productId: "ID_CARBON", quantity: 1 }
]
```

- Entre 2 y 40 productos distintos, con cantidades enteras positivas. Como el contenido solo puede referenciar `products`, un paquete no puede contener otro paquete ni a sí mismo.
- Todos sus productos son de la sucursal del paquete; si no, `PACKAGE_STORE_MISMATCH` con los `productIds` ajenos (también al cambiar el contenido con `updatePackage` y, por si hubiera datos inconsistentes, al cotizar o comprar el paquete: nunca se descuenta stock de otra sucursal).
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

`quoteOrder` recibe modalidad, partidas y una sucursal opcional (pista); cada partida indica `productId` **o** `packageId`. Carga el catálogo, obtiene la sucursal de los artículos (todas las partidas deben ser de la misma: `MIXED_STORES`; la pista debe coincidir: `STORE_MISMATCH`), comprueba disponibilidad y calcula importes sin crear un pedido ni descontar stock.

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
- `DELIVERY`: utiliza `deliveryFee` de la sucursal de los artículos.
- Si el subtotal después de descuentos alcanza `freeDeliveryThreshold` de esa sucursal, el envío cuesta cero.
- La sucursal siempre es la de los artículos; si está inactiva, la compra se rechaza con `STORE_INACTIVE`.

Al crear una orden de entrega, la ubicación se obtiene, en este orden, de una ubicación enviada explícitamente, un `addressId` del usuario, su dirección predeterminada o la primera disponible. Se exige dirección al crear la orden de entrega, pero no al cotizar.

### Crear y conservar el historial

`createOrder` verifica que el usuario exista y esté activo, obtiene la sucursal de los artículos, vuelve a calcular precios, **aparta el stock**, guarda el pedido con estado inicial `PENDING` y publica `ORDER_CREATED`. `checkoutCart` hace lo mismo con las partidas del carrito.

La orden es un recibo inmutable. Cada partida guarda solo lo cobrado: referencia (`productId` o `packageId`), nombre, unidad, cantidad, precio de lista, porcentaje aplicado e importe. Si se compró un paquete, copia su contenido (`contents`). La orden guarda además `deliveryFee` y `total` (lo cobrado al cliente). El descuento en pesos de cada partida, el `subtotal` y el `discountTotal` **se derivan** de las partidas y GraphQL los calcula al consultarlos. La ubicación de entrega también se copia; editar luego la dirección del usuario no modifica el pedido.

La clave opcional `idempotencyKey` evita crear otra orden para el mismo usuario y clave. El código devuelve la orden existente sin comparar el contenido de las dos solicitudes; una compra nueva debe usar una clave nueva.

### Estados permitidos

| Estado actual | Estados siguientes |
|---|---|
| `PENDING` | `CONFIRMED`, `CANCELLED` |
| `CONFIRMED` | `PREPARING`, `CANCELLED` |
| `PREPARING` | `READY`, `CANCELLED` |
| `READY` | `IN_DELIVERY` (solo DELIVERY), `DELIVERED` (solo PICKUP), `CANCELLED` |
| `IN_DELIVERY` | `DELIVERED`, `CANCELLED` |
| `DELIVERED` | Ninguno |
| `CANCELLED` | Ninguno |

`updateOrderStatus` aplica estas transiciones y publica `ORDER_STATUS_CHANGED`. `cancelOrder` delega en esa operación. Repetir el mismo estado se rechaza. La modalidad decide el camino desde `READY`: una orden PICKUP se entrega en mostrador (`READY → DELIVERED`; `IN_DELIVERY` da `PICKUP_CANNOT_BE_DELIVERED`) y una DELIVERY sale a reparto (`READY → IN_DELIVERY → DELIVERED`; `READY → DELIVERED` da `INVALID_STATUS_TRANSITION`).

### Historial de estados: `statusHistory`

Cada orden guarda su línea de tiempo en `statusHistory: [{ status, at, byUserId, byRole, inferred }]`, de la más antigua a la más reciente. Es un modelo de lectura para el cliente y el personal: la bitácora de auditoría (sección 9) sigue siendo el registro de seguridad, solo la lee ADMIN y no cambia (`ORDER_STATUS_CHANGED` se sigue publicando).

- **Solo se agrega**, una entrada por transición, con tope de 20 (hay siete estados y las transiciones no regresan; lo valida el modelo). `createOrder` y `checkoutCart` escriben la entrada inicial `PENDING` con el cliente como autor (`byRole: CUSTOMER`); cada cambio exitoso, incluida la cancelación (que repone el stock), agrega `{ status: destino, at: ahora, byUserId, byRole }` del usuario de la sesión.
- **Atómico con el cambio de estado.** `changeOrderStatus` valida la transición y la aplica con un solo `findOneAndUpdate` condicionado al estado validado (`{ _id, status: previo }`) que hace `$set` del estado y `$push` de la entrada. Si otra petición movió la orden antes, la escritura no hace nada, se relee la orden y se valida de nuevo contra el estado real: el perdedor recibe `ORDER_ALREADY_IN_STATUS` o `INVALID_STATUS_TRANSITION`, y si la transición sigue siendo válida (por ejemplo cancelar tras confirmar) se aplica y deja su propia entrada. Nunca hay una transición sin su entrada ni una entrada sin transición. Antes se hacía cargar y guardar con `optimisticConcurrency`, que fallaba el guardado del perdedor sin una respuesta de dominio; la actualización condicionada conserva esa exclusión y da el error correcto. La escritura incrementa `__v` para no romper a quien guarde un documento ya cargado.
- **GraphQL:** `Order.statusHistory: [OrderStatusChange!]!` con `{ status, at, byRole, by, inferred }`. Lo lee quien puede leer la orden (`canViewOrder`); no hay permiso nuevo.
- **Privacidad de `by`.** `by` es `OrderActor { id, name }`, no el `User` completo: ni correo ni direcciones de quien hizo el cambio (por ejemplo, el personal de mostrador no ve el domicilio del repartidor). Solo se resuelve para quien no es el cliente de la orden: el personal de la sucursal que puede verla, su repartidor o ADMIN (`canSeeStatusActor` en `domain/access.js`). Para el cliente es `null`, pero sigue viendo `byRole` (`STAFF`, `DELIVERY`...). Si el cliente es además ADMIN, en su propia orden tampoco ve `by`.
- **Órdenes anteriores.** Las creadas antes del historial se completan con la migración `backfillStatusHistory` (sección 3): entradas `inferred: true` y sin autor. Las nuevas son siempre `inferred: false`.

### Reparto: asignación del repartidor

Una orden DELIVERY en `READY` queda disponible para los repartidores de su sucursal. El flujo es **disponibles → aceptar → recoger → entregar**, con la opción de **liberar** mientras siga en `READY`:

1. **Disponibles:** `availableDeliveries(storeId, limit, offset)` lista las órdenes `DELIVERY` en `READY` y sin repartidor (`driverId: null`) de las sucursales del alcance de quien consulta (`orders:deliver`; con `storeId`, esa sucursal, que debe ser del alcance: si no, `STORE_NOT_ASSIGNED`; ADMIN ve todas), **la más antigua primero** (por `createdAt`).
2. **Aceptar:** `acceptDelivery(orderId)` exige `orders:deliver`, que la sucursal de la orden sea del alcance y que no sea una orden propia (`FORBIDDEN`, `OWN_ORDER`: nadie se reparte a sí mismo). Es **una sola escritura atómica**: `findOneAndUpdate` condicionado a `{ _id, status: READY, mode: DELIVERY, driverId: null }` que fija `driverId` y `assignedAt`. De dos aceptaciones simultáneas solo una encuentra la orden libre; la otra no escribe nada, relee la orden y recibe `ORDER_NOT_AVAILABLE` con `reason: TAKEN` (o `NOT_READY`, `PICKED_UP`, `NOT_DELIVERY`, `CANCELLED`, `DELIVERED` según la orden). Si el mismo repartidor la vuelve a aceptar (por ejemplo, al reintentar tras un corte de red) recibe la orden sin error. El estado no cambia (sigue `READY`), así que `statusHistory` no registra nada: la asignación se lee en `Order.driver` y `Order.assignedAt`. Se publica `DELIVERY_ACCEPTED`.
3. **Recoger y entregar:** `updateOrderStatus` a `IN_DELIVERY` y luego a `DELIVERED`, solo el repartidor asignado (o ADMIN si la orden ya tiene repartidor; ver "Reglas de órdenes" en la sección 2), sin saltarse `IN_DELIVERY`. Cada paso deja su entrada en `statusHistory` con `byRole: DELIVERY`. La escritura condicionada de `changeOrderStatus` incluye el `driverId` validado, así que si la orden se liberó o la tomó otro entre la validación y la escritura, se relee y se vuelve a validar quién puede: un repartidor que la recoge mientras alguien la libera recibe `NO_DRIVER_ASSIGNED` si la liberación llegó primero, y nunca queda una orden `IN_DELIVERY` sin repartidor.
4. **Liberar:** `releaseDelivery(orderId)` la devuelve a la lista de disponibles (limpia `driverId` y `assignedAt`) y publica `DELIVERY_RELEASED`. Pueden hacerlo el repartidor asignado (mientras tenga `orders:deliver`), el personal de mostrador de la sucursal (`orders:prepare`) o ADMIN, y solo mientras siga en `READY`: después de recogerla, `ORDER_NOT_AVAILABLE` con `reason: PICKED_UP`. Otro repartidor recibe `NOT_ASSIGNED_DRIVER`, o `NO_DRIVER_ASSIGNED` si la orden ya está libre. Liberar no es idempotente para el repartidor: si repite la llamada (por ejemplo, porque se perdió la respuesta) y la primera sí la liberó, ya no es su orden y recibe `NO_DRIVER_ASSIGNED` (o `NOT_ASSIGNED_DRIVER` si otro la aceptó en medio); la app debe tratar esos dos códigos, en un reintento, como "liberada". Para el personal de mostrador y ADMIN sí lo es: liberar una orden que ya está libre la devuelve sin cambios y sin evento.

**Una entrega activa por repartidor.** Una orden asignada en `READY` o `IN_DELIVERY` es la entrega activa de su repartidor, y solo puede tener una: aceptar otra da `ALREADY_DELIVERING` con `activeOrderId`. La garantía la da MongoDB con el índice único parcial `one_active_delivery_per_driver` (`driverId` único entre las órdenes con repartidor en `READY` / `IN_DELIVERY`): dos aceptaciones simultáneas del mismo repartidor para dos órdenes distintas no pueden quedar las dos escritas, porque la segunda viola el índice (E11000) y se responde `ALREADY_DELIVERING`. Al entregarla, cancelarla o liberarla, la orden sale del índice y el repartidor queda libre. No hace falta un documento guardián por repartidor ni limpiarlo si el proceso cae a la mitad: la regla vive en los propios pedidos.

- **Si el índice falta.** Al arrancar, después de `syncIndexes()`, mongoAPI comprueba que `one_active_delivery_per_driver` existe y, si no (por ejemplo, porque datos anteriores ya tienen dos órdenes activas con el mismo `driverId` y la creación falló), escribe un aviso `🚨 ÍNDICE AUSENTE` imposible de pasar por alto; la API sigue arrancando. Como defensa en profundidad, `acceptDelivery` consulta antes de escribir si el repartidor ya tiene otra entrega activa y responde `ALREADY_DELIVERING`: eso impide una segunda entrega en serie aunque falte el índice, pero ante dos aceptaciones simultáneas solo el índice es atómico. Se corrigen los pedidos duplicados y se reinicia mongoAPI.
- **Limitación conocida.** Un repartidor que pierde el teléfono (o deja de responder) después de recoger la orden conserva su entrega activa: no puede aceptar otra hasta que el personal de mostrador cancele la orden o ADMIN la entregue. Reasignar una orden `IN_DELIVERY` a otro repartidor queda fuera de esta etapa.

**Sin repartidor.** Una orden `IN_DELIVERY` siempre tiene repartidor: recoger una orden DELIVERY sin repartidor da `NO_DRIVER_ASSIGNED` a todos, ADMIN incluido. Si nadie la acepta, ADMIN la acepta él mismo (`acceptDelivery`; cuenta como su entrega activa) y la lleva: `driver` es el administrador y `statusHistory` registra `byRole: ADMIN`. ADMIN también puede recoger o entregar una orden que ya aceptó otro repartidor; el repartidor sigue en `driver` y queda libre al entregarla. Solo una orden `IN_DELIVERY` sin repartidor anterior a esta regla puede entregarla ADMIN tal cual.

**Cancelar** sigue las reglas de siempre (el cliente, o `orders:prepare` en la sucursal), también con la orden asignada o en camino. Cancelar una orden asignada conserva su `driverId` como historia (sigue saliendo en `driver` y en el historial del repartidor) y libera al repartidor.

**Qué ve cada quien.** La orden la leen su cliente, el personal de mostrador de la sucursal, su repartidor asignado (en cualquier estado y aunque lo hayan cambiado de sucursal, mientras siga teniendo `orders:deliver`: si vuelve a CUSTOMER deja de verla) y ADMIN; los demás repartidores de la sucursal, solo mientras está disponible. `Order.driver` es `OrderDriver { id, name }`: el cliente ve el nombre de su repartidor, nunca su correo ni su rol. En `orders`, el rol DELIVERY ve **solo las disponibles de sus sucursales más las asignadas a él** (antes veía todas las DELIVERY de su sucursal, en cualquier estado y de cualquier repartidor); `status` y `storeId` filtran sobre eso.

**Vistas del repartidor** (`orders:deliver`): `currentDelivery` devuelve su entrega activa o `null`; `myDeliveries(active: true)` la devuelve en una lista y `myDeliveries` (o `active: false`) su historial, entregadas y canceladas, la más reciente primero, con `limit` y `offset`. Una orden que liberó ya no es suya y no aparece.

### Inventario

El stock vive **solo** en `products.stock`. Como cada producto es de una sucursal, el stock es por sucursal por construcción: dos negocios que venden "lo mismo" tienen productos distintos. Los paquetes no tienen stock: vender un paquete descuenta cada producto de su contenido multiplicado por la cantidad comprada.

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
| Reparto | `availableDeliveries`, `myDeliveries`, `currentDelivery`; campos `driver` y `assignedAt` de `Order` | `acceptDelivery`, `releaseDelivery` |
| Listas | `shoppingLists`, `shoppingList` | `createShoppingList`, `addItemToShoppingList`, `removeItemFromShoppingList`, `deleteShoppingList` |
| Analítica | `salesReport`, `packageComponentDemand` | — |

`products` admite filtros por sucursal, categoría, búsqueda de texto y estado activo; `packages`, por sucursal y estado activo. `Store` expone `products`, `packages` y `categories`. Los reportes aceptan `storeId`. Productos, usuarios y pedidos usan `limit` y `offset`; el código limita el máximo de `limit` a 100, pero no implementa una validación completa de límites inferiores. Otros listados no están paginados.

GraphQL permite seleccionar campos de respuesta. Sin embargo, los resolvers actuales no implementan DataLoader ni derivan proyecciones MongoDB de la selección del cliente; una consulta con muchas relaciones puede ejecutar lecturas adicionales por cada elemento.

## 8. Consultas analíticas en MongoDB

Los dos reportes son **por sucursal**. Sin `storeId` cubren todas las sucursales del alcance de quien consulta (ADMIN: todas; MANAGER: sus `WORKS_AT`); con `storeId`, esa sucursal, que debe estar en el alcance (si no, `FORBIDDEN` con `reason: STORE_NOT_ASSIGNED`). Cada fila trae `storeId` y `storeName`.

### `salesReport(from, to, storeId)`

Consolida las ventas de pedidos `DELIVERED` cuya **fecha de creación** está dentro del rango, con ambos extremos inclusivos.

```text
$match(sucursales del alcance) → $unwind(items) → $group(storeId, productId, packageId) → $sort(revenue)
```

Devuelve sucursal, tipo (`PRODUCT` o `PACKAGE`), identificador, nombre, cantidad, ingresos netos de partidas y número de pedidos distintos. Los ingresos no incluyen la tarifa de envío ni distribuyen el ingreso de un paquete entre su contenido.

### `packageComponentDemand(from, to, storeId)`

Calcula los productos necesarios para surtir paquetes de pedidos no cancelados. Incluye pedidos pendientes; no representa exclusivamente ventas entregadas.

```text
$match(pedidos de las sucursales del alcance)
→ $unwind(items)
→ $match(items.packageId existe)
→ $unwind(items.contents)
→ $group(storeId, productId)
→ $lookup(products)
→ $sort(quantityNeeded)
```

Multiplica la cantidad de cada producto del contenido por el número de paquetes comprados y devuelve:

- `quantityNeeded`: unidades requeridas del producto.
- `packagesSold`: cantidad de paquetes que lo incluyen dentro del rango consultado.
- `inPackages`: número de paquetes distintos que lo incluyen.

Es un reporte de demanda para planear compras; el stock ya se descuenta al vender. El nombre del producto se obtiene del catálogo actual. Las cantidades de diferentes unidades no deben sumarse como si fueran equivalentes.

## 9. Bitácora de auditoría: RabbitMQ → ScyllaDB

mongoAPI **nunca** escribe en ScyllaDB: publica cada evento en la cola durable `pickaroo.events` (`RABBITMQ_QUEUE`, mensajes `persistent`) y sigue. `services/auditAPI` consume la cola y es el único servicio que escribe y lee ScyllaDB. Si RabbitMQ no está disponible el evento se descarta con un aviso: una caída del broker nunca interrumpe una compra o un login.

### Eventos

| Categoría | Eventos |
|---|---|
| `SECURITY` | `LOGIN_SUCCESS`, `LOGIN_FAILED` (con el motivo real), `LOGOUT`, `TOKEN_INVALID`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `ACCESS_DENIED` (operación y motivo), `RBAC_UNAVAILABLE`, `TOKEN_REFRESHED` (`familyId`, `jti` nuevo), `REFRESH_FAILED` (con el motivo real), `REFRESH_REUSED` (`familyId`), `SESSIONS_REVOKED` (`logoutAllDevices`) |
| `ADMIN` | `USER_REGISTERED`, `ROLE_CHANGED`, `STORE_ASSIGNMENT_CHANGED`, `SESSIONS_REVOKED` (cambio de rol o de sucursales; sesiones y familias de refresh tokens revocadas), `STORE_CREATED`, `STORE_UPDATED` |
| `CATALOG` | `CATEGORY_CREATED`, `PRODUCT_CREATED`, `PRODUCT_UPDATED` (cambios `{ from, to }`, p. ej. precio), `PRODUCT_ACTIVE_CHANGED`, `STOCK_SET`, `DISCOUNT_ADDED`, `DISCOUNT_REMOVED`, `PACKAGE_CREATED`, `PACKAGE_UPDATED`, `PACKAGE_ACTIVE_CHANGED` |
| `ORDER` | `ORDER_CREATED`, `ORDER_STATUS_CHANGED` (`from → to` y quién), `ORDER_REJECTED` (`PRICE_CHANGED`, `QUOTE_*`, `CART_*`, `MIXED_STORES`, `STORE_MISMATCH`, stock insuficiente), `DELIVERY_ACCEPTED` y `DELIVERY_RELEASED` (objetivo la orden; `metadata.driverId` es el repartidor que la aceptó o al que se le quitó) |

Los eventos de productos, paquetes, descuentos y stock (`CATALOG`) y los de órdenes `ORDER_CREATED`, `ORDER_STATUS_CHANGED`, `DELIVERY_ACCEPTED` y `DELIVERY_RELEASED` llevan la sucursal en `metadata.storeId`. `CATEGORY_CREATED` no la lleva (las categorías son globales) y `ORDER_REJECTED` tampoco (la compra no llegó a tener sucursal).

`ACCESS_DENIED` y `ORDER_REJECTED` se registran en un solo lugar: un plugin de Apollo (`auditPlugin` en `infrastructure/events.js`) que revisa los errores de cada operación. Nunca se registran contraseñas ni tokens.

Sobre de cada mensaje:

```javascript
{
  eventId: "uuid",            // lo genera el productor: idempotencia
  type: "PRODUCT_UPDATED",
  category: "CATALOG",
  actorId: "<userId>" | "ANONYMOUS",
  actorRole: "MANAGER",
  targetType: "Product", targetId: "<productId>",
  success: true,
  reason: "Precio $289 → $299",
  ip: "…", userAgent: "…",    // reenviados por el gateway
  metadata: { changes: { price: { from: 289, to: 299 } } },
  occurredAt: "2026-11-12T18:00:00.000Z"
}
```

### Tablas en ScyllaDB (keyspace `pickaroo_audit`)

Diseño por consulta: cada evento se escribe (batch con log) en las tablas que le corresponden, ordenadas por `occurred_at DESC`.

| Tabla | Clave de partición | Responde | Consulta GraphQL |
|---|---|---|---|
| `events_by_day` | `(category, day)` | "eventos de seguridad de hoy" | `auditEvents(category, day, type, limit)`, `auditSummary(day)` |
| `events_by_actor` | `(actor_id)` | "qué hizo este usuario" (no se escribe para `ANONYMOUS`) | `auditByActor(actorId, limit)` |
| `events_by_target` | `(target_type, target_id)` | "historia de la orden X", "historial de precios del producto Y" | `auditByTarget(targetType, targetId, limit)` |

- `day` es la fecha UTC del evento (`YYYY-MM-DD`).
- `AuditEvent.actor` es la entidad `User` federada: el gateway la completa con el subgrafo `pickaroo` (nombre, correo…).
- El consumidor hace `ack` solo después de escribir. Si la escritura falla, el mensaje vuelve a la cola tras 5 segundos. Si ScyllaDB no está listo al arrancar, auditAPI no consume y los eventos esperan en RabbitMQ.
- El `eventId` lo pone el productor, así que un mensaje reentregado reescribe la misma fila. Los mensajes del formato anterior (`{ event, payload }`) también se aceptan.
- auditAPI valida el mismo JWT y la misma sesión de Redis que mongoAPI, y exige el permiso `audit:view` (solo ADMIN).

## 10. Configuración y ejecución local

### Requisitos

- Node.js compatible con las versiones de Apollo Server declaradas en los paquetes.
- npm con soporte para workspaces.
- Docker Desktop o un motor Docker con Docker Compose activo.
- Puertos `27017`, `5672`, `15672`, `6379`, `8001`, `7474`, `7687`, `9042`, `4000`, `4001` y `4003` disponibles.

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
REFRESH_TTL_SECONDS=2592000
REFRESH_REUSE_GRACE_SECONDS=10
SEED=false
```

`REDIS_URL` coincide con la contraseña (`--requirepass`) del servicio `redis` del Compose y es también el valor de respaldo del código. `JWT_SECRET` debe definirse: si falta, el servicio genera uno aleatorio al arrancar y todos los tokens dejan de ser válidos en cada reinicio. `JWT_TTL_SECONDS` es la vida del token de acceso y de su sesión (1 hora por omisión); `REFRESH_TTL_SECONDS`, la de cada refresh token (30 días por omisión; cada canje entrega uno con la vida completa); `REFRESH_REUSE_GRACE_SECONDS`, la ventana de gracia de un canje (10 s por omisión, 0 la desactiva). Para generar uno:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Neo4j (los valores de respaldo coinciden con el Compose):

```dotenv
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=pickaroo123
```

Opcionales: `CACHE_TTL_PRODUCT` (120), `CACHE_TTL_USER` (3600) y `CACHE_DEBUG=true`.

`npm run migrate` (desde la raíz) aplica las migraciones de datos con este mismo `MONGODB_URI`, sin arrancar la API. No hace falta en el uso normal: mongoAPI las corre al arrancar.

### Variables de auditAPI

auditAPI lee **`services/auditAPI/.env`** y, para lo que no defina, **`services/mongoAPI/.env`**: así comparte `JWT_SECRET` y `REDIS_URL` sin copiarlos. En producción ambos servicios deben recibir el mismo `JWT_SECRET`.

```dotenv
PORT_AUDITORIA=4003
SCYLLADB_CONTACT_POINTS=127.0.0.1
SCYLLADB_PORT=9042
SCYLLADB_KEYSPACE=pickaroo_audit
RABBITMQ_URL=amqp://guest:guest@localhost:5672
```

Sustituir `CONTRASENA_DEL_COMPOSE` por el valor de `MONGO_INITDB_ROOT_PASSWORD` del YAML. Si contiene caracteres reservados de una URI, deben codificarse. El usuario y contraseña deben coincidir con los que inicializaron el volumen de MongoDB; editar el YAML no cambia automáticamente las credenciales de un volumen existente.

El valor de respaldo del código es `mongodb://localhost:27017/pickaroodb`, sin autenticación. Para el MongoDB autenticado del Compose se necesita la URI completa.

### Variables del Gateway

Crear **`gateway/.env`**:

```dotenv
PORT_GATEWAY=4000
PORT_CAMPAMENTOS=4001
PORT_AUDITORIA=4003
```

`PORT_CAMPAMENTOS` conserva un nombre del boilerplate, pero configura el puerto de mongoAPI. Debe coincidir en ambos archivos. Al ejecutar los scripts mediante workspaces, cada proceso carga su `.env` desde su propio directorio; un `.env` en la raíz no sustituye automáticamente estos archivos.

### Levantar servicios

Desde la raíz:

```bash
docker compose up -d
npm run dev
```

`npm run dev` arranca mongoAPI, auditAPI y el Gateway. Para arrancarlos por separado, cada uno en su terminal:

```bash
npm run dev:campamentos
```

```bash
npm run dev:auditoria
```

```bash
npm run dev:gateway
```

ScyllaDB tarda alrededor de un minuto en aceptar conexiones después de `docker compose up`; auditAPI reintenta solo y empieza a consumir cuando está listo.

El comando `dev:campamentos` apunta a `services/mongoAPI`; no se debe sustituir por un nombre de script que no esté definido en `package.json`.

### Pruebas

Desde la raíz, sin levantar Docker:

```bash
npm test
```

Ejecuta las pruebas unitarias del dominio y del contrato de errores (`services/mongoAPI/test/`, con el ejecutor integrado de Node; incluye una guardia estática que revisa el código de ambos subgrafos) y `npm run schema:check`, de modo que un `schema/api.graphql` desactualizado también hace fallar el comando. Termina con código distinto de cero si algo falla.

| Servicio | Dirección local |
|---|---|
| Gateway GraphQL | `http://localhost:4000/` |
| Subgrafo mongoAPI | `http://localhost:4001/graphql` |
| Subgrafo auditAPI | `http://localhost:4003/graphql` |
| MongoDB | `localhost:27017`, base recomendada `pickaroodb` |
| RabbitMQ AMQP | `localhost:5672` |
| Panel RabbitMQ | `http://localhost:15672/` |
| Redis Stack | `localhost:6379` |
| RedisInsight | `http://localhost:8001/` |
| Neo4j Browser | `http://localhost:7474/` (usuario `neo4j`) |
| Neo4j Bolt | `localhost:7687` |
| ScyllaDB (CQL) | `localhost:9042`, keyspace `pickaroo_audit` |

El Gateway intenta componer los subgrafos hasta 15 veces, con una espera de dos segundos entre fallos. mongoAPI y auditAPI deben estar disponibles dentro de ese periodo (auditAPI responde aunque ScyllaDB aún no esté listo).

### Pruebas de integración

Con el Compose arriba (`docker compose up -d`), desde la raíz:

```bash
npm run test:integration
```

Prueban la API completa por HTTP, a través de un Gateway propio y con los usuarios del seed: inicio de sesión por rol, refresh tokens (rotación, ventana de gracia, reutilización, canjes simultáneos, vencimiento, cierre de sesión por dispositivo y en todos, revocación por cambios de acceso, TTL de cada clave en Redis), permisos por familia y por sucursal, catálogo, carrito y compra con cotización, ciclo de pedidos, reparto (entregas disponibles, aceptaciones simultáneas, una entrega activa por repartidor, liberar, la ruta del repartidor asignado), bitácora, el marketplace (catálogo, carrito, compras, permisos y reportes por sucursal) y la migración de `storeId` (corre `migrate.js` dos veces contra `pickaroodb_it`). Están en `test/integration/` (fuera de `services/mongoAPI/test/`, así `npm test` sigue siendo rápido y sin Docker) y usan el ejecutor integrado de Node. Una corrida tarda alrededor de minuto y medio (la prueba de vencimiento del refresh token espera a que caduque).

- **Qué arranca:** su propia copia de mongoAPI, auditAPI y el Gateway como procesos `node` (sin `--watch`) en los puertos 5001, 5003 y 5000, con la base `pickaroodb_it` sembrada (`SEED=true`), un `JWT_SECRET` nuevo en cada corrida, `REFRESH_TTL_SECONDS=10` (para probar el vencimiento), `REFRESH_REUSE_GRACE_SECONDS=2` (para probar lo que pasa después de la ventana) y la base lógica 1 de Redis (la 0 es la del dev). Neo4j, RabbitMQ (cola `pickaroo.events`) y ScyllaDB son los mismos contenedores. La configuración va en el entorno de cada proceso: no lee ni escribe archivos `.env`. La contraseña de MongoDB sale de `docker-compose.yml` (o de `IT_MONGO_PASSWORD`) y no se imprime. Espera el `Seed OK` y a que el Gateway responda; al terminar, también si una prueba falla o con Ctrl+C, detiene sus procesos. Los puertos se cambian con `IT_GATEWAY_PORT`, `IT_MONGOAPI_PORT` e `IT_AUDITAPI_PORT`.
- **No toca los datos del dev:** puede correr con `npm run dev` levantado. Antes y después compara los documentos por colección de `pickaroodb`, las sucursales en Neo4j y que el Gateway de `:4000` responda; si algo cambió, la corrida falla (usar la app del dev mientras corre también lo marcaría).
- **Limpieza:** borra de Neo4j los nodos `User` y `Store` con los ids de `pickaroodb_it`; de Redis, las sesiones (por `jti`), los refresh tokens con sus marcas de usado, sus registros de gracia y sus familias, carritos, cotizaciones, pedidos recientes y copias de caché de esos ids; y elimina `pickaroodb_it`. Si una corrida anterior quedó a medias, limpia sus restos al empezar. El catálogo RBAC de Neo4j (roles, permisos y menú) es compartido: el mongoAPI de pruebas lo vuelve a escribir igual al arrancar.
- **Lo que no se limpia:** las filas de auditoría en ScyllaDB (la bitácora es inmutable) y los mensajes de RabbitMQ. El auditAPI del dev y el de pruebas consumen la misma cola y escriben en la misma ScyllaDB, así que cualquiera de los dos puede guardar un evento de la corrida; las pruebas de bitácora consultan hasta que aparece.
- **Sin Docker:** si un servicio del Compose no responde, las pruebas se omiten con un mensaje (`integration tests skipped: MongoDB not reachable on localhost:27017`) y el comando termina con código 0. Nunca arranca Docker ni contenedores.

### Persistencia y apagado

Compose utiliza `mongo:8.0`, `rabbitmq:3.13-management`, `redis/redis-stack:latest`, `neo4j:5.26` y `scylladb/scylla:5.4` (modo desarrollo, 1 CPU, 750 MB), con la red `pickaroo-network` y los volúmenes:

- `mongodb_data`, montado en `/data/db`.
- `rabbitmq_data`, montado en `/var/lib/rabbitmq`.
- `redis_data`, montado en `/data` (Redis con `--appendonly yes`, así las sesiones sobreviven a un reinicio del contenedor).
- `neo4j_data`, montado en `/data` del contenedor de Neo4j.
- `scylla_data`, montado en `/var/lib/scylla`.

```bash
docker compose ps
docker compose logs --tail=100 mongodb rabbitmq redis neo4j scylladb
docker compose down
```

`down` conserva los volúmenes; `down -v` los elimina (y con ellos las sesiones y el caché). MongoDB está configurado como standalone, sin replica set. Si el MongoDB, RabbitMQ, Redis, Neo4j o ScyllaDB de HITO1 (o de otro proyecto) sigue publicando los puertos `27017`, `5672`, `6379`, `8001`, `7474`, `7687` o `9042`, ambos Compose no podrán utilizarlos simultáneamente.

## 11. Datos de demostración

Para habilitar el seed, establecer `SEED=true` en el `.env` de mongoAPI y reiniciar ese proceso. La carga se ejecuta después de iniciar el servidor, por lo que debe esperarse al mensaje `Seed OK` antes de consultar los ejemplos.

En una base vacía crea dos negocios independientes del marketplace:

- La sucursal `CARNYFRUT Centro`, con tarifa de reparto de $35 y envío gratuito desde $400 después de descuentos.
- La sucursal `Frutería La Huerta` (Calle Libertad 450, Col. Obrera), con tarifa de reparto de $25 y envío gratuito desde $250.
- Ocho usuarios de demostración (contraseñas solo de desarrollo). El seed asigna la contraseña también a usuarios demo ya existentes que no tengan una.

  | Correo | Rol | Sucursal (`WORKS_AT`) | Contraseña | Variable para cambiarla |
  |---|---|---|---|---|
  | `admin@carnyfrut.mx` | ADMIN | todas (`scope:all_stores`) | `Admin1234` | `SEED_ADMIN_PASSWORD` |
  | `gerente@carnyfrut.mx` | MANAGER | CARNYFRUT Centro | `Manager1234` | `SEED_MANAGER_PASSWORD` |
  | `empleado@carnyfrut.mx` | STAFF | CARNYFRUT Centro | `Staff1234` | `SEED_STAFF_PASSWORD` |
  | `repartidor@carnyfrut.mx` | DELIVERY | CARNYFRUT Centro | `Delivery1234` | `SEED_DELIVERY_PASSWORD` |
  | `repartidor2@carnyfrut.mx` | DELIVERY | CARNYFRUT Centro | `Delivery1234` | `SEED_DELIVERY2_PASSWORD` |
  | `gerente@lahuerta.mx` | MANAGER | Frutería La Huerta | `Manager1234` | `SEED_HUERTA_MANAGER_PASSWORD` |
  | `empleado@lahuerta.mx` | STAFF | Frutería La Huerta | `Staff1234` | `SEED_HUERTA_STAFF_PASSWORD` |
  | `cliente@demo.mx` | CUSTOMER (con dirección predeterminada) | — | `Cliente1234` | `SEED_CUSTOMER_PASSWORD` |

- En Neo4j, los ocho usuarios con su rol y el personal asignado a su sucursal (`WORKS_AT`). Un rol ya existente en el grafo no se cambia. Si Neo4j no está arriba durante el seed, el personal queda sin sucursal hasta volver a ejecutarlo.
- Cuatro categorías globales: Carnes, Frutas, Verduras y Abarrotes.
- En CARNYFRUT Centro: once productos y un paquete familiar para carne asada con ocho productos; una promoción del 15% incrustada en el producto Plátano.
- En Frutería La Huerta: seis productos de Frutas y Verduras (manzana, naranja, aguacate, jitomate, chile jalapeño y papa) y el paquete "Canasta para guacamole y salsa" con tres de ellos.

Con dos repartidores en CARNYFRUT Centro se puede ver la carrera por una orden: los dos aceptan la misma orden lista y solo uno gana (el otro recibe `ORDER_NOT_AVAILABLE`, `TAKEN`).

El seed no crea pedidos ni listas de compra. Busca registros existentes por nombre o correo (productos y paquetes, por nombre dentro de su sucursal) y no sobrescribe sus datos comerciales. Esta estrategia evita duplicados en ejecuciones secuenciales normales, pero los nombres de producto, paquete y sucursal no tienen un índice único que garantice lo mismo ante ejecuciones concurrentes.

> **Bases creadas antes del marketplace:** los productos y paquetes sin `storeId` se asignan solos a la sucursal activa más antigua al arrancar (sección 3, "Migración al marketplace").
>
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
    refreshToken
    refreshExpiresIn
    user { id name role }
  }
}
```

Variables: `{ "input": { "email": "admin@carnyfrut.mx", "password": "Admin1234" } }`.

Copiar `token` y enviarlo en cada petición como encabezado `Authorization: Bearer <token>` (en Apollo Sandbox, pestaña *Headers*). `query { me { id name role } }` confirma la sesión y `mutation { logout }` la revoca.

Para seguir sin la contraseña cuando el token vence, canjear el refresh token (sin encabezado `Authorization`) y guardar el par nuevo: el anterior ya no sirve.

```graphql
mutation Refresh($token: String!) {
  refreshToken(token: $token) { token expiresIn refreshToken refreshExpiresIn }
}
```

`mutation { logout(refreshToken: "…") }` cierra la sesión y además revoca ese dispositivo; `mutation { logoutAllDevices }` cierra todas las sesiones del usuario.

Las demás consultas de este apartado se ejecutan con ese encabezado; el catálogo (`products`, `packages`, `stores`) y `quoteOrder` también funcionan sin él. Para `users`, los reportes y las mutaciones de catálogo se necesita el token del administrador; para `createOrder` y las listas, el del cliente (o el del administrador).

### Explorar catálogo y paquetes

```graphql
query Catalogo {
  products(limit: 20, offset: 0) {      # todas las sucursales activas; storeId: "ID_SUCURSAL" para una
    id
    name
    unit
    price
    effectivePrice
    activeDiscountPercent
    imageUrl
    stock
    store { id name }
    category { id name }
  }
  packages {
    id
    name
    price
    availableStock
    alaCarteTotal
    savings
    store { id name }
    items {
      quantity
      product { id name unit }
    }
  }
  stores {
    id name address { street city } deliveryFee freeDeliveryThreshold
    categories { id name }
    products(limit: 5) { id name price }
  }
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

Variables (cada partida lleva `productId` **o** `packageId`, todas de la misma sucursal; `storeId` es opcional y, si se manda, debe ser la de los artículos):

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
query Analitica($from: DateTime!, $to: DateTime!, $storeId: ID) {
  salesReport(from: $from, to: $to, storeId: $storeId) {
    storeId storeName type itemId name quantity revenue orderCount
  }
  packageComponentDemand(from: $from, to: $to, storeId: $storeId) {
    storeId storeName productId name quantityNeeded packagesSold inPackages
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

`storeId` es opcional: sin él, las sucursales del alcance de quien consulta. Los reportes pueden devolver arreglos vacíos si no existen pedidos en los estados y fechas correspondientes.

## 13. Clientes: esquema y conexión

**`schema/api.graphql`** es el esquema que ven los clientes (app Android y dashboard) a través del gateway, sin la maquinaria de federación (`@key`, `_entities`, `join__*`…). Los clientes generan sus tipos a partir de este archivo, sin levantar servidores ni bases de datos. Está generado: no se edita a mano.

```bash
npm run schema:build   # compone los schema.graphql de los subgrafos y escribe schema/api.graphql
npm run schema:check   # falla si el archivo está desactualizado; no lo modifica
```

Los errores se traducen por `extensions.code` (catálogo completo en la sección 2, "Códigos de error y contrato de traducción"); el `message` es solo para logs.

Todo cambio en un `schema.graphql` de un subgrafo debe ir acompañado, **en el mismo commit**, del `schema/api.graphql` regenerado.

URLs del gateway para los clientes:

| Cliente | URL |
|---|---|
| Dashboard (navegador) | `http://localhost:4000/` |
| Emulador de Android | `http://10.0.2.2:4000/` (`10.0.2.2` es la dirección del equipo anfitrión vista desde el emulador) |

El CORS del gateway está abierto en desarrollo (valor por defecto del servidor independiente de Apollo) y debe restringirse antes de cualquier despliegue.

Para configurar cada servicio se puede copiar su plantilla: `gateway/.env.example`, `services/mongoAPI/.env.example` y `services/auditAPI/.env.example` (a `.env` en la misma carpeta). Los secretos son marcadores de posición que deben sustituirse.

## 14. Alcance y consideraciones de mantenimiento

Esta versión contiene los elementos de Docker, dominio, Mongoose, GraphQL y agregación del núcleo documental, pero su presencia no equivale a una certificación de funcionamiento bajo carga o en producción.

Aspectos relevantes al continuar el desarrollo:

- La autenticación es JWT + sesión en Redis, con refresh tokens rotativos de un solo uso. No hay limitación de intentos de `login` ni de `refreshToken`, recuperación ni cambio de contraseña, ni una operación para desactivar usuarios. Los intentos fallidos sí quedan en la bitácora (`LOGIN_FAILED`).
- Los roles viven en Neo4j; MongoDB guarda un espejo. Si se edita el grafo a mano (sin `assignRole`), el cambio aplica en el siguiente login del usuario, no en sus sesiones abiertas.
- Cada sucursal es un negocio con su propio catálogo y stock; todavía no hay un rol de dueño de sucursal (OWNER) ni una relación `OWNS`: el alcance del personal sale solo de `WORKS_AT`.
- La bitácora es de "al menos una vez": si RabbitMQ no está disponible cuando mongoAPI publica, ese evento se pierde (no hay outbox). auditAPI no expone borrado ni edición de eventos.
- Las contraseñas se guardan con `scrypt` y sal aleatoria (`scrypt$sal$hash`). Con el registro abierto (`createUser` sin sesión) cualquiera puede crear cuentas `CUSTOMER`.
- Sin Redis nadie puede iniciar sesión ni usar un token existente (falla cerrado); el catálogo público sigue disponible.
- El caché es de lectura. Las copias de producto pueden mostrar datos de hasta `CACHE_TTL_PRODUCT` segundos de antigüedad si MongoDB se modifica por fuera de la API; las compras siempre usan MongoDB. El caché y las sesiones asumen un solo proceso de mongoAPI.
- El stock es de cada producto y, por lo tanto, de su sucursal. El descuento de stock al comprar es atómico por producto pero no es una transacción multidocumento junto con la orden.
- Las listas guardadas (`shoppingLists`) pueden mezclar artículos de varias sucursales; si el cliente agrega sus artículos al carrito, el carrito rechaza los de otra sucursal (`CART_STORE_MISMATCH`).
- La idempotencia no compara el contenido de solicitudes repetidas.
- Las cantidades son enteras: no se puede pedir medio kilo de un producto vendido por `KG`.
- La selección de campos GraphQL no evita por sí sola consultas repetidas al resolver relaciones.
- Existen pruebas unitarias de las reglas de dominio (`domain/entities.js` y `domain/access.js`), que se ejecutan con `npm test` y no necesitan Docker ni bases de datos, y pruebas de integración contra el Compose (`npm run test:integration`, sección 10) que recorren el Gateway, los resolvers y las bases. Los ejemplos de este README son procedimientos de uso, no evidencia de pruebas ejecutadas.

Para cambiar estas conductas debe modificarse la implementación y mantenerse sincronizada la documentación. Este README no altera modelos, operaciones, datos ni infraestructura.
