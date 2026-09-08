# PickarooAPI

Backend GraphQL de Pickaroo para administrar un catálogo comercial, paquetes de productos, sucursales, usuarios, listas de compra y pedidos con recogida o entrega a domicilio. La implementación incluye datos de demostración de CARNYFRUT, orientados a productos para carne asada y parrilladas.

El componente principal es **`services/mongoAPI`**: contiene las reglas de negocio, los modelos documentales de MongoDB y las operaciones de la API. **Apollo Gateway** publica un punto de entrada unificado, mientras que **RabbitMQ** recibe eventos de pedidos para una futura integración de auditoría u otros consumidores.

Este documento describe el código presente en **PickarooAPI**. La carpeta externa **HITO1** es otra implementación; sus nombres de campos, reglas de descuentos, unidades monetarias y manejo de inventario no deben asumirse equivalentes.

## 1. Arquitectura y componentes

```mermaid
flowchart LR
  Cliente[Cliente GraphQL] --> Gateway[Apollo Gateway\nlocalhost:4000]
  Gateway --> API[mongoAPI\nlocalhost:4001]
  API --> Dominio[Reglas de dominio\ndomain/entities.js]
  API --> Mongoose[Modelos Mongoose]
  Mongoose --> Mongo[(MongoDB\nDocker:27017)]
  API --> Rabbit[RabbitMQ\nDocker:5672]
```

| Componente | Responsabilidad |
|---|---|
| Apollo Gateway | Componer el subgrafo `pickaroo` y exponer su contrato GraphQL a los clientes. |
| mongoAPI | Ejecutar consultas y mutaciones, coordinar validaciones, persistir documentos y publicar eventos. |
| Dominio | Encapsular reglas de productos, composición de paquetes, precios, descuentos, entrega y estados de pedidos. |
| Mongoose | Definir tipos, restricciones, subdocumentos, referencias e índices de MongoDB. |
| MongoDB | Almacenar las colecciones del negocio y ejecutar los pipelines analíticos. |
| RabbitMQ | Recibir los eventos `ORDER_CREATED` y `ORDER_STATUS_CHANGED`. No hay consumidor implementado en este repositorio. |

El Gateway y mongoAPI son procesos Node.js ejecutados en el equipo anfitrión. El archivo Compose levanta únicamente MongoDB y RabbitMQ, no los procesos Node.js.

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
            ├── schema.graphql
            ├── domain/
            │   └── entities.js
            └── infrastructure/
                ├── mongoose-models.js
                └── seed.js
```

Los archivos `.env` son configuración local y están excluidos de Git.

## 2. Responsabilidades de mongoAPI

### Contrato GraphQL: `src/schema.graphql`

El SDL define los tipos de salida, los inputs, los enums y las operaciones disponibles. Utiliza Apollo Federation 2.3 y declara entidades con `@key(fields: "id")` para `User`, `Category`, `Product`, `Store` y `Order`.

El cliente puede solicitar los campos que necesita, incluyendo relaciones como la categoría de un producto o los componentes de un paquete. El esquema también incorpora:

- `DateTime`: fechas serializadas como cadenas ISO-8601.
- `ProductKind`: `SIMPLE` y `PAQUETE`.
- `Unit`: `UNIDAD`, `KG`, `GRAMO`, `LITRO` y `PAQUETE`.
- `OrderMode`: `PICKUP` y `DELIVERY`.
- `UserRole`: `CUSTOMER` y `ADMIN`.
- `OrderStatus`: estados del ciclo de vida del pedido.

Los importes se exponen como `Float` en **pesos mexicanos**, no como centavos enteros. Las cantidades de carrito, composición y stock son enteros; por ejemplo, `quantity: 2` de un producto con `unit: KG` representa dos kilogramos. El contrato actual no admite `quantity: 0.5`.

### Dominio: `src/domain/entities.js`

La capa de dominio no importa Mongoose ni Apollo. Su clase `Product` y sus funciones centralizan las siguientes reglas:

| Elemento | Función |
|---|---|
| `assertProductPersistable` | Exigir nombre válido, precio positivo, stock entero no negativo y composición coherente. |
| `Product.assertPurchasable` | Comprobar que el producto esté activo, que la cantidad sea positiva y que exista stock suficiente para esa partida. |
| `bestDiscountPercentage` | Seleccionar el mayor porcentaje entre los descuentos vigentes. |
| `applyDiscount` | Calcular el precio unitario después del descuento. |
| `priceOrder` | Construir las partidas históricas y calcular subtotal, descuento, envío y total. |
| `deliveryFee` | Determinar el costo de entrega según la sucursal y su umbral de envío gratuito. |
| `assertTransition` | Validar cambios de estado del pedido. |
| `buildOrderNumber` | Generar un número con formato `PK-AAAAMMDD-SUFIJO`. |

`round2` y `sumMoney` redondean los importes a dos decimales usando `Number`. Este comportamiento es distinto del cálculo en centavos con aritmética entera de HITO1.

### Persistencia: `src/infrastructure/mongoose-models.js`

Los modelos invocan las reglas del dominio cuando corresponde y agregan validaciones de estructura: textos con límites y `trim`, cantidades enteras, mínimos numéricos, valores enumerados, fechas y arreglos acotados.

Todos los esquemas principales habilitan `timestamps`, que genera `createdAt` y `updatedAt`, y `optimisticConcurrency` para las operaciones de guardado de documentos. Esto no equivale a una transacción entre varias colecciones.

### Coordinación y arranque: `src/index.js`

El proceso del servicio realiza estas acciones:

1. Carga las variables de entorno y lee el SDL desde disco.
2. Espera la conexión con MongoDB antes de iniciar la API.
3. Ejecuta `syncIndexes()` para cada modelo. Los errores de índices se registran como advertencias y no detienen por sí mismos el arranque.
4. Intenta conectar con RabbitMQ y declarar la cola de eventos.
5. Construye y publica el subgrafo con Apollo Server.
6. Si `SEED=true`, ejecuta la carga de demostración después de que el servidor empieza a escuchar.

`syncIndexes()` puede crear o eliminar índices para alinearlos con los esquemas. El inicio del servicio no es, por tanto, una operación estrictamente de solo lectura sobre la base.

## 3. Modelo documental

La aplicación exporta seis modelos principales:

| Colección | Información principal | Datos incrustados o referencias |
|---|---|---|
| `users` | Nombre, correo, rol, estado y avatar. | `addresses[]`: hasta 25 direcciones; como máximo una predeterminada. |
| `categories` | Nombre, slug, icono y orden de presentación. | Los productos la referencian mediante `categoryId`. |
| `products` | Nombre, descripción, precio, imagen, unidad, stock, estado y tipo. | `discounts[]`: hasta 20 promociones. `components[]`: hasta 40 productos para un paquete. |
| `stores` | Dirección, ciudad, horario, contacto y política de reparto. | Los pedidos la referencian mediante `storeId`. |
| `orders` | Número, usuario, sucursal, estado, importes y notas. | Hasta 200 partidas y una copia de la dirección de entrega. |
| `shopping_lists` | Usuario y nombre de la lista. | Hasta 200 partidas; cada una referencia un producto. |

### Incrustación

Se utiliza cuando la información pertenece al documento principal y se consulta junto con él:

- Las direcciones están dentro de `users.addresses`.
- Los descuentos están dentro de `products.discounts`.
- La composición de un paquete está dentro de `products.components`.
- Las partidas están dentro de `orders.items` y `shopping_lists.items`.
- La dirección elegida se copia en `orders.deliveryAddress`.

**En esta versión no existen colecciones independientes llamadas `user_addresses`, `product_discounts`, `order_items` o `inventories`.** Esos nombres pueden aparecer como antecedentes del esquema SQL o en otra implementación, pero no son modelos exportados aquí.

### Referenciación

Las relaciones compartidas se representan con `ObjectId`: categoría de un producto, usuario y sucursal de un pedido, productos de una lista y productos que forman un paquete.

Los pedidos se conservan en su propia colección para que el historial de un usuario crezca sin quedar incrustado en su documento. Una referencia Mongoose no es una clave foránea que MongoDB verifique automáticamente: la aplicación comprueba la existencia de entidades en distintas operaciones.

### Índices principales

- Correo de usuario y slug de categoría únicos.
- Número de pedido único.
- Usuario y clave de idempotencia únicos cuando la clave es una cadena.
- Categoría/tipo y estado activo de productos.
- Índice de texto sobre nombre y descripción de productos.
- Pedidos por usuario, estado, fecha y sucursal.
- Listas por usuario y fecha de actualización.

## 4. Productos individuales y paquetes

### Producto individual: `SIMPLE`

Es una unidad vendible del catálogo, con precio y stock propios. Su arreglo `components` debe estar vacío. `createProduct` comprueba que exista la categoría y persiste el documento validado.

### Portafolio o combo: `PAQUETE`

El nombre técnico utilizado aquí es **`PAQUETE`**, no `PORTAFOLIO`. Se crea con `createPackage`, indicando categoría, nombre, precio, stock y composición.

La composición requiere:

- Entre 2 y 40 productos.
- Cantidades enteras positivas.
- Referencias sin duplicados ni autorreferencia.
- Productos existentes de tipo `SIMPLE`; no se admiten paquetes anidados en esa operación.

Ejemplo conceptual:

```javascript
components: [
  { productId: "ID_ARRACHERA", quantity: 2 },
  { productId: "ID_CARBON", quantity: 1 }
]
```

Las unidades corresponden a cada producto referenciado. Si la arrachera está expresada en `KG`, la cantidad 2 representa dos kilogramos.

El precio del paquete se introduce explícitamente; no se calcula automáticamente a partir de sus componentes y no se crea una promoción del 10% al darlo de alta. Los campos GraphQL `alaCarteTotal` y `packageSavings` comparan su precio efectivo contra los precios efectivos actuales de los componentes. La diferencia puede ser negativa; no existe una validación que obligue al paquete a ser más barato.

`PackageInput` no expone `unit`; el alta utiliza el valor predeterminado del modelo, `UNIDAD`. El seed sí asigna explícitamente `PAQUETE` como unidad. Esta diferencia forma parte del comportamiento actual.

### Imágenes

`imageUrl` está disponible en el modelo y en `Product`, `ProductInput`, `PackageInput` y `ProductUpdateInput` del SDL. Permite guardar y consultar una URL externa, por ejemplo de Cloudinary. La API no sube archivos ni almacena los bytes de la imagen.

Mongoose limita la longitud a 500 caracteres y elimina espacios en los extremos; no valida que el texto sea una URL HTTPS ni comprueba que la imagen exista.

## 5. Descuentos

Las promociones se guardan como subdocumentos de `products.discounts`, con identificador propio:

| Campo | Significado |
|---|---|
| `discountPercentage` | Porcentaje entre 0.01 y 100. Por ejemplo, `10` significa 10%. |
| `label` | Descripción opcional de la promoción. |
| `startsAt` | Inicio opcional; `null` significa sin restricción de inicio. |
| `endsAt` | Fin opcional; `null` significa sin vencimiento. |
| `isActive` | Habilita o deshabilita la promoción. |

Cuando hay varias promociones, se utiliza el mayor porcentaje vigente y no se acumulan. El código considera válidos los instantes iguales al inicio y al final; descarta una promoción cuando la fecha actual es posterior a `endsAt`.

`activeDiscountPercentage` muestra el porcentaje elegido y `effectivePrice` el precio unitario resultante. Al comprar se conservan el porcentaje, el descuento monetario y el importe de la partida. Un paquete utiliza sus propios descuentos, no los de sus componentes internos.

El esquema admite 100%, por lo que el importe final puede ser cero aunque el precio base sea positivo. La etiqueta de una promoción es descriptiva: escribir `2x1` no implementa una mecánica de dos por uno.

Las operaciones disponibles son `addProductDiscount` y `removeProductDiscount`. No existe una mutación específica para editar una promoción o alternar `isActive` una vez creada.

## 6. Cotización y ciclo de pedidos

### Cotizar sin guardar

`quoteOrder` recibe modalidad, sucursal opcional y partidas. Carga el catálogo, comprueba disponibilidad por partida y calcula importes sin crear un pedido ni descontar stock.

El cálculo utiliza:

```text
precio unitario efectivo = redondear(precio base × (1 − porcentaje / 100))
importe de partida       = redondear(precio unitario efectivo × cantidad)
descuento de partida     = redondear((precio base − precio efectivo) × cantidad)
subtotal                 = suma de precios base × cantidades
total                    = subtotal − descuentos + envío
```

La cotización no reserva existencias. La disponibilidad puede cambiar antes de crear la orden.

### Política de entrega

- `PICKUP`: el envío cuesta cero.
- `DELIVERY`: utiliza `deliveryFee` de la sucursal.
- Si el subtotal después de descuentos alcanza `freeDeliveryThreshold`, el envío cuesta cero.
- Si no se indica sucursal, la operación busca la primera sucursal activa.

Al crear una orden de entrega, la dirección se obtiene, en este orden, de una dirección enviada explícitamente, un `addressId` del usuario, su dirección predeterminada o la primera disponible. Se exige dirección al crear la orden de entrega, pero no al cotizar.

### Crear y conservar el historial

`createOrder` verifica usuario y sucursal, vuelve a calcular precios, guarda el pedido con estado inicial `PENDING`, descuenta stock de las partidas y publica `ORDER_CREATED`.

Cada partida conserva nombre, tipo, unidad, cantidad, precio de lista, porcentaje aplicado, descuento monetario e importe. Si se compró un paquete, copia sus referencias de componentes y cantidades. La dirección también se copia; editar luego la dirección del usuario no modifica el pedido.

El nombre de cada componente interno no se copia en esa estructura: los campos relacionales y el reporte de demanda pueden consultar su nombre actual en el catálogo.

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

### Inventario: comportamiento y límites actuales

El stock vive en **`products.stock`**, tanto para productos individuales como para paquetes. No se separa por sucursal y no existe un campo de reservas.

Al comprar un paquete se descuenta su propio stock. **No se descompone la venta para descontar existencias de los productos incluidos.** Su composición se utiliza para describir el contenido y elaborar reportes.

Las escrituras se ejecutan por separado: primero se crea el pedido y después se decrementan los productos. No se usa una transacción multidocumento ni un filtro de disponibilidad en el decremento. Por ello, la validación previa no garantiza ausencia de sobreventa ante concurrencia, partidas repetidas o fallos entre escrituras. Al cancelar se guarda el estado y luego se repone stock, también mediante escrituras separadas.

El carrito no tiene un campo `extras` ni una asociación entre partidas adicionales y un paquete. Es posible incluir un paquete y productos individuales en la misma compra, pero estos últimos quedan como partidas independientes.

## 7. Operaciones GraphQL

El SDL es la referencia completa de argumentos y tipos. Las operaciones se organizan así:

| Área | Queries | Mutations |
|---|---|---|
| Usuarios | `users`, `user` | `createUser`, `addUserAddress`, `setDefaultAddress`, `removeUserAddress` |
| Categorías | `categories`, `category` | `createCategory` |
| Catálogo | `products`, `product`, `packages` | `createProduct`, `createPackage`, `updateProduct`, `setProductActive`, `setProductStock` |
| Descuentos | Campos `discounts`, `activeDiscountPercentage`, `effectivePrice` de `Product` | `addProductDiscount`, `removeProductDiscount` |
| Sucursales | `stores`, `store` | `createStore`, `updateStore` |
| Pedidos | `quoteOrder`, `orders`, `order`, `orderByNumber` | `createOrder`, `updateOrderStatus`, `cancelOrder` |
| Listas | `shoppingLists`, `shoppingList` | `createShoppingList`, `addItemToShoppingList`, `removeItemFromShoppingList`, `deleteShoppingList` |
| Analítica | `salesReport`, `packageComponentDemand` | — |

`products` admite filtros por categoría, tipo, búsqueda de texto y estado activo. Productos, usuarios y pedidos usan `limit` y `offset`; el código limita el máximo de `limit` a 100, pero no implementa una validación completa de límites inferiores. Otros listados no están paginados.

GraphQL permite seleccionar campos de respuesta. Sin embargo, los resolvers actuales no implementan DataLoader ni derivan proyecciones MongoDB de la selección del cliente; una consulta con muchas relaciones puede ejecutar lecturas adicionales por cada elemento.

## 8. Consultas analíticas en MongoDB

### `salesReport(from, to)`

Consolida las ventas de pedidos `DELIVERED` cuya **fecha de creación** está dentro del rango, con ambos extremos inclusivos.

```text
$match → $unwind(items) → $group(productId) → $sort(revenue)
```

Devuelve nombre, tipo, cantidad, ingresos netos de partidas y número de pedidos distintos. Los ingresos no incluyen la tarifa de envío. Los paquetes aparecen como productos vendidos, sin distribuir sus ingresos entre componentes.

### `packageComponentDemand(from, to)`

Calcula los productos necesarios para surtir paquetes de pedidos no cancelados. Incluye pedidos pendientes; no representa exclusivamente ventas entregadas.

```text
$match(pedidos)
→ $unwind(items)
→ $match(items.kind = PAQUETE)
→ $unwind(items.components)
→ $group(productId)
→ $lookup(products)
→ $sort(quantityNeeded)
```

Multiplica la cantidad de cada componente por el número de paquetes comprados y devuelve:

- `quantityNeeded`: unidades requeridas del componente.
- `packagesSold`: cantidad de paquetes que lo incluyen dentro del rango consultado.
- `inPackages`: número de productos-paquete distintos que lo incluyen.

Es un reporte de demanda; **no modifica ni sincroniza el inventario**. El nombre del componente se obtiene del catálogo actual. Las cantidades de diferentes unidades no deben sumarse como si fueran equivalentes.

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
- Puertos `27017`, `5672`, `15672`, `4000` y `4001` disponibles.

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
SEED=false
```

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

El Gateway intenta componer el subgrafo hasta 15 veces, con una espera de dos segundos entre fallos. Es necesario que mongoAPI llegue a estar disponible dentro de ese periodo.

### Persistencia y apagado

Compose utiliza `mongo:8.0` y `rabbitmq:3.13-management`, con la red `pickaroo-network` y los volúmenes:

- `mongodb_data`, montado en `/data/db`.
- `rabbitmq_data`, montado en `/var/lib/rabbitmq`.

```bash
docker compose ps
docker compose logs --tail=100 mongodb rabbitmq
docker compose down
```

`down` conserva los volúmenes; `down -v` los elimina. MongoDB está configurado como standalone, sin replica set. Si el MongoDB de HITO1 sigue publicando el puerto `27017`, ambos Compose no podrán utilizarlo simultáneamente.

## 11. Datos de demostración

Para habilitar el seed, establecer `SEED=true` en el `.env` de mongoAPI y reiniciar ese proceso. La carga se ejecuta después de iniciar el servidor, por lo que debe esperarse al mensaje `Seed OK` antes de consultar los ejemplos.

En una base vacía crea:

- Una sucursal `CARNYFRUT Centro`, con tarifa de reparto de $35 y envío gratuito desde $400 después de descuentos.
- Dos usuarios de demostración.
- Cinco categorías.
- Once productos individuales y un paquete familiar con ocho componentes.
- Una promoción del 15% incrustada en el producto Plátano.

El seed no crea pedidos ni listas de compra. Busca registros existentes por slug, correo o nombre y no sobrescribe sus datos comerciales. Como compatibilidad, si encuentra la sucursal heredada `Carnyfruit Centro` o el correo `admin@carnyfruit.mx`, corrige únicamente el nombre a `CARNYFRUT Centro` y el correo a `admin@carnyfrut.mx`. Esta estrategia evita duplicados en ejecuciones secuenciales normales, pero los nombres de producto y sucursal no tienen un índice único que garantice lo mismo ante ejecuciones concurrentes.

Los datos, precios y cantidades del seed son demostrativos. No equivalen a los 14 productos y seis portafolios preparados en HITO1. Después de cargar los ejemplos puede establecerse `SEED=false` para evitar repetir el proceso en cada arranque.

## 12. Ejemplos de uso

Ejecutar las operaciones en el Gateway. Los identificadores de los ejemplos deben sustituirse por los obtenidos de la base actual.

### Explorar catálogo y paquetes

```graphql
query Catalogo {
  products(limit: 20, offset: 0) {
    id
    name
    kind
    unit
    price
    effectivePrice
    activeDiscountPercentage
    imageUrl
    stock
    category { id name }
  }
  packages {
    id
    name
    price
    effectivePrice
    alaCarteTotal
    packageSavings
    components {
      quantity
      product { id name unit }
    }
  }
  stores { id name deliveryFee freeDeliveryThreshold }
  users(limit: 10) { id name addresses { id label street } }
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
    items { name quantity unitPrice discountApplied lineTotal }
  }
}
```

Variables:

```json
{
  "input": {
    "mode": "PICKUP",
    "storeId": "ID_SUCURSAL",
    "items": [
      { "productId": "ID_PRODUCTO_O_PAQUETE", "quantity": 1 }
    ]
  }
}
```

### Crear una orden

Esta operación persiste una orden y descuenta stock; no es una consulta de prueba sin efectos.

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
      { "productId": "ID_PRODUCTO_O_PAQUETE", "quantity": 1 }
    ]
  }
}
```

### Asociar una imagen a un producto

```graphql
mutation Imagen($id: ID!, $input: ProductUpdateInput!) {
  updateProduct(id: $id, input: $input) {
    id
    name
    imageUrl
  }
}
```

Enviar en `input` un objeto con `imageUrl` igual a la URL pública real de la imagen. La misma operación sirve para productos de tipo `PAQUETE`.

### Reportes

```graphql
query Analitica($from: DateTime!, $to: DateTime!) {
  salesReport(from: $from, to: $to) {
    productId name kind quantity revenue orderCount
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

- No hay autenticación ni autorización de operaciones implementadas. El rol almacenado no protege por sí mismo las mutaciones.
- `createUser` antepone `plain:` a la contraseña recibida; no utiliza un algoritmo de hash. No debe tratarse como almacenamiento seguro de credenciales reales.
- El stock es global por producto y los paquetes tienen stock propio; no existe consumo automático de componentes, reserva por sucursal ni garantía transaccional de compra.
- La idempotencia no compara el contenido de solicitudes repetidas y no recupera automáticamente escrituras de stock interrumpidas después de guardar una orden.
- La selección de una sucursal o usuario por ID no comprueba sistemáticamente que estén activos en todas las operaciones.
- Las promociones están incrustadas y no hay descuento automático del 10% para paquetes.
- La selección de campos GraphQL no evita por sí sola consultas repetidas al resolver relaciones.
- No se incluyen pruebas automatizadas ni un script `test` en los paquetes actuales. Los ejemplos de este README son procedimientos de uso, no evidencia de pruebas ejecutadas.

Para cambiar estas conductas debe modificarse la implementación y mantenerse sincronizada la documentación. Este README no altera modelos, operaciones, datos ni infraestructura.
