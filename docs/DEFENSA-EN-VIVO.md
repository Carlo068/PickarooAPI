# Guía de la defensa en vivo

Guion para leer y seguir durante la defensa. Cada paso se ensayó contra el entorno real de desarrollo (Docker Compose + `npm run dev` por separado); las salidas de ejemplo son las que se vieron, recortadas. Las IDs, la hora y los contadores van a variar.

| # | Escenario | Dónde | Tiempo |
|---|---|---|---|
| 1 | Grafo RBAC navegable | Neo4j Browser | 3 min |
| 2 | Permisos: FORBIDDEN contra éxito | Apollo Sandbox | 4 min |
| 3 | Menú dinámico por rol | Apollo Sandbox | 2 min |
| 4 | Mensajes en la cola | Panel de RabbitMQ | 4 min |
| 5 | Persistencia | `cqlsh` en ScyllaDB | 3 min |
| 6 | Fail-safe | `docker stop` de RabbitMQ | 3 min |

Orden recomendado: 1, 2, 3, 4, 5, 6. El 4 deja eventos nuevos en ScyllaDB y el 5 los consulta; el 6 va al final porque apaga RabbitMQ.

---

## A. Antes de empezar

### A.1 Checklist (hacerla 15 minutos antes)

- [ ] Docker Desktop abierto y en verde (ballena sin animación).
- [ ] Desde la raíz del repositorio (`PickarooAPI`): `docker compose up -d`.
- [ ] Esperar alrededor de 1 minuto a ScyllaDB. Comprobar: `docker exec pickaroo-scylladb cqlsh -e "DESCRIBE KEYSPACES;"` responde sin error.
- [ ] Los 5 contenedores arriba: `docker ps --format "{{.Names}} {{.Status}}"` (mongodb, redis, neo4j, rabbitmq, scylladb).
- [ ] Tres terminales (A.2) con los servicios levantados y los logs de A.4.
- [ ] Navegador con 3 pestañas abiertas: Neo4j Browser, Apollo Sandbox y panel de RabbitMQ (A.3). Sandbox necesita Internet (carga su interfaz desde un CDN de Apollo).
- [ ] Una terminal extra (4.ª) en la raíz del repositorio para `docker` y `cqlsh`. Usar PowerShell o cmd; en Git Bash `docker exec -it` necesita `winpty` delante.
- [ ] Hacer el login de cada usuario justo antes de usarlo (el token dura 1 hora).
- [ ] Probar una vez el escenario 2 y el 5: quedan filas frescas de hoy en ScyllaDB.

### A.2 Las tres terminales (en este orden)

Tres terminales, todas en la raíz del repositorio. Así Ctrl+C en la del worker detiene solo el worker (escenario 4) y las otras dos siguen vivas.

| Terminal | Comando | Qué es | Listo cuando |
|---|---|---|---|
| 1 | `npm run dev:auditoria` | worker + subgrafo auditAPI (:4003) | ~3 s |
| 2 | `npm run dev:campamentos` | mongoAPI (:4001), el productor | 5 a 15 s (incluye el seed) |
| 3 | `npm run dev:gateway` | Gateway (:4000) | ~4 s después de las otras dos |

El Gateway necesita a las dos primeras al arrancar (reintenta 15 veces cada 2 s); después ya no. No usar `npm run dev` en la defensa: junta los tres procesos en una terminal y no se puede detener solo el worker.

### A.3 URLs y credenciales

| Qué | URL | Usuario / contraseña |
|---|---|---|
| Apollo Sandbox (GraphQL) | http://localhost:4000/ | ver A.5 |
| Neo4j Browser | http://localhost:7474/browser/ | `neo4j` / la de `docker-compose.yml`, variable `NEO4J_AUTH` (formato `usuario/contraseña`: la contraseña es lo que va después de `neo4j/`). Local de desarrollo, ya versionada: `pickaroo123` |
| Panel de RabbitMQ | http://localhost:15672/ | `guest` / `guest` |
| ScyllaDB | `docker exec -it pickaroo-scylladb cqlsh` | sin usuario |

Neo4j Browser: en "Connect to instance" valen el protocolo por omisión (`neo4j://localhost:7687`) o `bolt://localhost:7687`; solo hay que escribir la contraseña.

### A.4 Líneas de arranque esperadas

Terminal 1 (worker):

```
📊 Subgrafo de Auditoría (ScyllaDB + consumidor RabbitMQ) listo en: http://localhost:4003/
🗄️  ScyllaDB conectado. Keyspace "auditoria" y tablas de auditoría listos.
📥 Consumiendo la cola "eventos-seguridad" hacia ScyllaDB (prefetch 50).
```

Terminal 2 (mongoAPI):

```
🌿 Catálogo RBAC listo en Neo4j: 5 roles, 9 permisos, 12 rutas, 16 elementos de menú, 2 sucursal(es).
✅ RabbitMQ conectado. Cola "eventos-seguridad" lista.
🛒 Subgrafo Pickaroo (catálogo + órdenes) listo en: http://localhost:4001/
🌱 Seed OK: 17 productos, 2 paquete/s, ...   (solo con SEED=true en services/mongoAPI/.env)
```

Terminal 3 (Gateway):

```
🚀 API Gateway (Supergraph) unificada y lista en: http://localhost:4000/ (pickaroo, auditoria)
```

Si el Gateway imprime `⏳ Subgrafos aún no disponibles (1/15)` es normal: aún arrancan las otras dos. Fíjate en que el nombre de la cola sea `eventos-seguridad` en las dos primeras terminales (ver D.5).

### A.5 Usuarios de demostración

Contraseñas de desarrollo (README, sección 11).

| Rol | Correo | Contraseña | Para qué |
|---|---|---|---|
| CUSTOMER | `cliente@demo.mx` | `Cliente1234` | el que recibe FORBIDDEN |
| STAFF | `empleado@carnyfrut.mx` | `Staff1234` | mostrador de CARNYFRUT Centro |
| MANAGER | `gerente@carnyfrut.mx` | `Manager1234` | hereda de STAFF; usar este (no `gerente@lahuerta.mx`, que es de otra sucursal) |
| ADMIN | `admin@carnyfrut.mx` | `Admin1234` | hereda de MANAGER; todo |
| CUSTOMER desechable | `defensa@demo.mx` | `Defensa1234` | para el cambio de rol del escenario 4 |

### A.6 Cómo se usa Apollo Sandbox (vale para los escenarios 2, 3, 4 y 6)

1. Abrir http://localhost:4000/ (se ve "Apollo Server" y luego el Sandbox con la dirección `http://localhost:4000/`).
2. Pegar la operación en el panel central; las variables, en la pestaña **Variables** (abajo).
3. Botón de ejecutar; la respuesta sale a la derecha.
4. Para llevar sesión: pestaña **Headers** (abajo) → **New header** → clave `Authorization`, valor `Bearer ` seguido del token (con el espacio). Son dos casillas (clave y valor), no un JSON. Para cambiar de usuario basta cambiar el valor de esa misma fila.
5. El token sale de la mutación `login` (escenario 2, paso 1): se selecciona el valor de `token` en la respuesta y se copia.

---

## 1. Neo4j Browser: el grafo RBAC navegable

**Objetivo.** Mostrar que los permisos viven en un grafo: roles que heredan, roles con rutas y menú, y un usuario que llega a un permiso por herencia.

**Pasos.**

1. Abrir http://localhost:7474/browser/. Conectar con usuario `neo4j` y la contraseña de `docker-compose.yml` (variable `NEO4J_AUTH`, la parte después de `neo4j/`). El panel izquierdo (*Database information*) muestra 52 nodos y 83 relaciones, con las etiquetas `MenuNode`, `Permission`, `Role`, `Route`, `Store`, `User`.
2. Pegar cada consulta en la barra de arriba y ejecutar con el botón de play (a la derecha). Elegir la vista **Graph**.
3. Al terminar cada una, limpiar la barra (Ctrl+A y pegar la siguiente) para que no se acumulen marcos.

**Consulta 1. Jerarquía de roles** (4 relaciones `INHERITS`, 5 roles):

```cypher
MATCH p=(:Role)-[:INHERITS]->(:Role) RETURN p
```

Se ve ADMIN → MANAGER → STAFF → CUSTOMER y DELIVERY → CUSTOMER.

**Consulta 2. Roles, permisos y rutas** (13 `CAN_ACCESS` hacia 12 rutas):

```cypher
MATCH p=(:Role)-[:CAN_ACCESS]->(:Route) RETURN p
```

```cypher
MATCH p=(:Role)-[:HAS_PERMISSION]->(:Permission) RETURN p
```

Cada ruta cuelga solo del rol más bajo que puede entrar; los superiores entran por herencia.

**Consulta 3. Árbol del menú** (todas las relaciones de los nodos de menú: 42 en total, 12 `HAS_CHILD`, 12 `NAVIGATES_TO` y 18 `CAN_VIEW_MENU`; 33 nodos):

```cypher
MATCH (m:MenuNode)-[r]-(x) RETURN m, r, x
```

Se ven los 4 menús raíz (Tienda, Sucursal, Reparto, Administración), sus hijos, la ruta de cada hijo y qué rol ve cada nodo.

**Consulta 4. De un usuario a sus permisos por herencia** (la que mejor explica la herencia):

```cypher
MATCH p=(u:User {email: 'gerente@carnyfrut.mx'})-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(e:Role)
OPTIONAL MATCH q=(e)-[:HAS_PERMISSION]->(:Permission)
RETURN p, q
```

Sale el gerente → MANAGER → STAFF → CUSTOMER, con los permisos de cada rol colgando (8 nodos: 1 usuario, 3 roles y 4 permisos). Para ADMIN, cambiar el correo por `admin@carnyfrut.mx`.

**Consulta 5. Por qué el MANAGER puede ajustar stock** (prepara el escenario 2):

```cypher
MATCH p=(u:User {email: 'gerente@carnyfrut.mx'})-[:HAS_ROLE]->(:Role)-[:INHERITS*0..]->(:Role)-[:HAS_PERMISSION]->(:Permission {name: 'stock:manage'})
RETURN p
```

Un solo camino: gerente → MANAGER → STAFF → `stock:manage`. Con `cliente@demo.mx` devuelve 0 filas.

**Consulta 6. Restricciones de unicidad:**

```cypher
SHOW CONSTRAINTS
```

Seis restricciones `unique_*` (`unique_user_id`, `unique_role_name`, `unique_route_path`, `unique_menu_id`, `unique_permission_name`, `unique_store_id`).

**Qué decir.** "Los permisos no están en una tabla de roles: están en un grafo. Cada rol hereda del inferior con `INHERITS`, y la API pregunta al grafo con un recorrido `INHERITS*0..`. Un gerente no tiene `stock:manage` propio: lo alcanza por STAFF."

**Consejos de pantalla.**

- Los nodos aparecen sin texto hasta que se hace zoom con la rueda del ratón; el título que se ve es `name`, `title` (menú) o `path` (rutas). Clic en un tipo de nodo en el panel derecho (*Results overview*) abre el estilo (color, tamaño, caption).
- Doble clic en un nodo expande sus vecinos.
- Para ver el grafo completo: `MATCH (n)-[r]->(m) RETURN n, r, m` (83 relaciones; se ve denso).

**Plan B.** Si el Browser no abre o no conecta, mostrar los mismos resultados en tabla desde la terminal (sustituir `<contraseña>`):

```bash
docker exec pickaroo-neo4j cypher-shell -u neo4j -p <contraseña> "MATCH (a:Role)-[:INHERITS]->(b:Role) RETURN a.name AS rol, b.name AS hereda_de ORDER BY rol"
```

Salida: `ADMIN → MANAGER`, `DELIVERY → CUSTOMER`, `MANAGER → STAFF`, `STAFF → CUSTOMER`. Si el grafo sale vacío, ver D.4.

---

## 2. Apollo Sandbox: FORBIDDEN contra éxito (herencia de permisos)

**Objetivo.** Una misma mutación sensible (`setProductStock`, permiso `stock:manage`): un CUSTOMER es rechazado y un MANAGER, que no tiene ese permiso propio pero lo hereda de STAFF, la ejecuta. Es inocua: se deja el stock en el valor que ya tiene.

**Preparación (una vez).** En Sandbox, obtener la ID y el stock actual del producto de ejemplo:

```graphql
query {
  products(search: "Plátano") { id name stock store { name } }
}
```

Respuesta (la ID será la tuya):

```json
{ "data": { "products": [ { "id": "6ac834f8bea9d52a36a420d8", "name": "Plátano", "stock": 150, "store": { "name": "CARNYFRUT Centro" } } ] } }
```

Copiar `id` y `stock`. Aquí: `150`.

**Paso 1. Login como CUSTOMER.** Operación:

```graphql
mutation Login($input: LoginInput!) {
  login(input: $input) {
    token
    access { role permissions }
  }
}
```

Variables:

```json
{ "input": { "email": "cliente@demo.mx", "password": "Cliente1234" } }
```

Respuesta (token recortado): `access.role` = `CUSTOMER`, `access.permissions` = `[]`. Copiar el valor de `token`. Ir a **Headers** → **New header** → clave `Authorization`, valor `Bearer <token>`.

**Paso 2. La mutación como CUSTOMER.** Operación:

```graphql
mutation SetStock($id: ID!, $stock: Int!) {
  setProductStock(id: $id, stock: $stock) { id name stock }
}
```

Variables (con la ID y el stock reales del producto):

```json
{ "id": "6ac834f8bea9d52a36a420d8", "stock": 150 }
```

Resultado real:

```json
{
  "errors": [
    {
      "message": "Se requiere el permiso \"stock:manage\".",
      "path": [ "setProductStock" ],
      "extensions": {
        "permission": "stock:manage",
        "reason": "PERMISSION_REQUIRED",
        "code": "FORBIDDEN",
        "stacktrace": [ "..." ],
        "serviceName": "pickaroo"
      }
    }
  ],
  "data": null
}
```

El arreglo `stacktrace` es del modo desarrollo (trae rutas del equipo); ignorarlo y señalar `code`, `reason` y `permission`.

**Paso 3. Login como MANAGER** (misma mutación `Login`, otras variables), cambiar el valor del header y repetir el Paso 2:

```json
{ "input": { "email": "gerente@carnyfrut.mx", "password": "Manager1234" } }
```

`access.permissions` del gerente: `catalog:manage`, `orders:prepare`, `reports:view`, `stock:manage` (los dos últimos heredados). Resultado del Paso 2 con su token:

```json
{ "data": { "setProductStock": { "id": "6ac834f8bea9d52a36a420d8", "name": "Plátano", "stock": 150 } } }
```

Con STAFF (`empleado@carnyfrut.mx`, permiso propio) y con ADMIN (hereda de MANAGER) también pasa.

**Paso 4. Ruta de pantalla: `canAccessRoute`** (consulta el grafo de Neo4j; cambiar el token y repetir):

```graphql
query {
  catalogo: canAccessRoute(path: "/catalogo")
  inventario: canAccessRoute(path: "/sucursal/inventario")
  reportes: canAccessRoute(path: "/admin/reportes")
  usuarios: canAccessRoute(path: "/admin/usuarios")
}
```

| Usuario | catalogo | inventario | reportes | usuarios |
|---|---|---|---|---|
| CUSTOMER | true | false | false | false |
| STAFF | true | true | false | false |
| MANAGER | true | true | true | false |
| ADMIN | true | true | true | true |

Sin cabecera `Authorization` cualquier operación de sesión responde `UNAUTHENTICATED` ("Debes iniciar sesión.").

**Qué decir.** "La API responde un error GraphQL tipado: `extensions.code` es `FORBIDDEN`, el equivalente semántico de un 403. GraphQL reporta los errores en el cuerpo de la respuesta, por eso el estado HTTP sigue siendo 200: no es un HTTP 403. Que el gerente pase sin tener `stock:manage` propio es la herencia del grafo: MANAGER → STAFF."

**Plan B.**

- Si Sandbox no carga (sin Internet) o falla el header, hacer lo mismo desde PowerShell (tokens: cambiar el correo y la contraseña):

```powershell
function Gql($q, $v, $t) {
  $hd = @{ 'Content-Type' = 'application/json' }; if ($t) { $hd.Authorization = "Bearer $t" }
  $b = @{ query = $q; variables = $v } | ConvertTo-Json -Depth 6
  Invoke-RestMethod http://localhost:4000/ -Method Post -Headers $hd -Body $b
}
$t = (Gql 'mutation($i: LoginInput!){ login(input:$i){ token } }' @{ i = @{ email = 'cliente@demo.mx'; password = 'Cliente1234' } }).data.login.token
Gql 'mutation($id: ID!, $stock: Int!){ setProductStock(id:$id, stock:$stock){ id name stock } }' @{ id = '<ID>'; stock = 150 } $t | ConvertTo-Json -Depth 6
```

- `UNAUTHENTICATED` de repente: el token cumplió su hora. Repetir el login.
- El producto es de CARNYFRUT Centro: si se usa `gerente@lahuerta.mx`, el error es `FORBIDDEN` con `reason: STORE_NOT_ASSIGNED` (otra regla, la de sucursal).

---

## 3. Menú dinámico por rol

**Objetivo.** Un mismo query devuelve un menú distinto según el rol, calculado en Neo4j.

**Pasos.** Con el login de cada usuario (Sección 2, Paso 1) y su header `Authorization`, ejecutar:

```graphql
query {
  myMenu {
    id title order path
    children { id title order path }
  }
}
```

También llega dentro del login: `login(input: $input) { token menu { title children { title } } }`.

Resultado real (raíz → hijos):

| Rol | Menús raíz | Elementos |
|---|---|---|
| CUSTOMER | Tienda | Catálogo, Mi carrito, Mis pedidos, Mis listas (5 en total) |
| STAFF | Tienda, Sucursal | lo de CUSTOMER + Pedidos de la sucursal, Inventario (8) |
| MANAGER | Tienda, Sucursal, Administración | lo de STAFF + Productos y paquetes, Reportes (11) |
| ADMIN | Tienda, Sucursal, Reparto, Administración | lo de MANAGER + Entregas (Reparto) + Sucursales, Usuarios y roles, Auditoría (16) |

(DELIVERY, si se pregunta: Tienda y Reparto.)

Fragmento real del CUSTOMER:

```json
{ "data": { "myMenu": [ { "id": "tienda", "title": "Tienda", "order": 1, "path": null,
  "children": [ { "id": "catalogo", "title": "Catálogo", "order": 1, "path": "/catalogo" },
                { "id": "carrito", "title": "Mi carrito", "order": 2, "path": "/carrito" } ] } ] } }
```

El mismo menú se ve en el grafo con la consulta 3 del escenario 1.

**Qué decir.** "El cliente no decide qué botones mostrar: pregunta `myMenu` y Neo4j responde con los nodos que el rol, o un rol que hereda, puede ver (`CAN_VIEW_MENU`). Cada nodo trae la ruta (`NAVIGATES_TO`). Si cambia el rol, cambia el menú sin tocar la app."

**Plan B.** Menú vacío o `myMenu: []`: ver D.4. Respuesta `UNAUTHENTICATED`: falta el header o el token venció.

---

## 4. Panel de RabbitMQ: ver los mensajes en la cola

**Objetivo.** Mostrar que la API publica eventos de seguridad en la cola `eventos-seguridad` sin esperar a nadie, que los mensajes no llevan secretos y que el worker los drena.

El worker consume al instante; para ver mensajes hay que detenerlo antes. Por eso las tres terminales.

**Pasos.**

1. Abrir http://localhost:15672/ (`guest` / `guest`) → pestaña **Queues and Streams**. La lista trae otras colas (`pickaroo.events`, `transmisiones-auditoria`) de versiones anteriores: ignorarlas. Entrar a **`eventos-seguridad`**: `Ready 0`, `Consumers 1` (el worker).
2. **Terminal 1 (worker): Ctrl+C.** Si Windows pregunta "¿Terminar el trabajo por lotes (S/N)?", responder `S`. En la terminal 2 y la 3 no pasa nada. En el panel, en unos 5 s, `Consumers` pasa a 0.
3. Provocar eventos desde Sandbox (Sección 2, Paso 1 y header si hace falta):
   - **Login fallido.** `Login` con `{ "input": { "email": "admin@carnyfrut.mx", "password": "incorrecta-123" } }` → error con `extensions.code` `INVALID_CREDENTIALS`.
   - **Login correcto.** `Login` con `admin@carnyfrut.mx` / `Admin1234` (queda con el token de ADMIN en el header).
   - **Cambio de rol (reversible).** Con el token de ADMIN:

     ```graphql
     mutation Registro($input: CreateUserInput!) {
       createUser(input: $input) { id email role }
     }
     ```

     ```json
     { "input": { "name": "Usuario Defensa", "email": "defensa@demo.mx", "password": "Defensa1234" } }
     ```

     Devuelve la `id` del usuario. Si responde `EMAIL_ALREADY_REGISTERED`, ya existe del ensayo: obtener su `id` con `login` (`login(input: $input) { user { id } }`) y el mismo usuario. Luego:

     ```graphql
     mutation Rol($userId: ID!, $role: UserRole!) {
       assignRole(userId: $userId, role: $role) { role permissions }
     }
     ```

     Ejecutarla con `{ "userId": "<id>", "role": "STAFF" }` y después **revertir** con `{ "userId": "<id>", "role": "CUSTOMER" }` (un administrador no puede cambiar su propio rol: `CANNOT_CHANGE_OWN_ROLE`).
4. En el panel, la cola sube en unos 5 s (el panel se refresca cada 5 s y los contadores van con ese retraso). Con los pasos de arriba son 5 mensajes: `LOGIN_FAILED`, `LOGIN_SUCCESS`, `USER_REGISTERED` y 2 × `ROLE_CHANGED` (cada login extra suma un `LOGIN_SUCCESS`). Subir **Messages** a un número mayor si hay más.
5. Ver el contenido. **Primero** arriba a la derecha cambiar *Refresh every 5 seconds* a **Do not refresh** (el refresco cierra el panel que se está abriendo). Bajar a **Get messages**, dejar **Ack Mode: `Nack message requeue true`** (así se queda en la cola), **Messages: 5** y pulsar **Get Message(s)**. Cuidado: debajo están *Delete* y *Purge*; no tocarlas.
6. Lo que se ve en cada mensaje (real, recortado; el cuerpo completo también trae `targetType`, `targetId` y `userAgent`):

   ```json
   {
     "eventId": "b107572c-c987-4422-a06b-7211a03eb165",
     "type": "LOGIN_FAILED",
     "category": "SECURITY",
     "actorId": "6ac834f8bea9d52a36a420b3",
     "actorRole": "ADMIN",
     "success": false,
     "reason": "Contraseña incorrecta",
     "ip": "::1",
     "metadata": { "email": "admin@carnyfrut.mx" },
     "occurredAt": "2026-11-18T06:20:11.961Z"
   }
   ```

   Señalar: no hay `password`, ni hash, ni token; el texto `incorrecta-123` no aparece; `reason` es un texto fijo, no lo que escribió el usuario. El `LOGIN_SUCCESS` solo trae identificadores y conteos (`jti`, `familyId`, `permissions: 9`).
7. **Reiniciar el worker** en la terminal 1: `npm run dev:auditoria` (flecha arriba, Enter). Tarda unos 3 s en arrancar e imprime una línea por evento, por ejemplo:

   ```
   📥 [SECURITY] LOGIN_FAILED actor=6ac834f8bea9d52a36a420b3 role=ADMIN success=false ip=::1 at=2026-11-18T06:20:11.961Z → ScyllaDB
   📥 [ADMIN] ROLE_CHANGED actor=6ac834f8bea9d52a36a420b3 role=ADMIN success=true ip=::1 at=2026-11-18T06:20:33.527Z → ScyllaDB
   ```

   En el panel (con *Refresh every 5 seconds* de nuevo) **Ready** y **Unacked** bajan a 0 en unos 5 s y `Consumers` vuelve a 1; la línea de *Queued messages* cae a 0. En el ensayo la cola quedó en 0 unos 6 s después de lanzar el comando (3 s de arranque más el refresco del panel).

**Qué decir.** "La API publica el evento y sigue, no espera a nadie: el login no depende del broker. Los mensajes esperan en la cola durable mientras el consumidor está caído y se drenan al volver, sin perder ninguno. El mensaje no lleva contraseñas ni tokens: las fábricas de eventos no los reciben y hay un depurador por si algo se cuela."

**Plan B.**

- Si el worker consumió antes de abrir el panel (no se alcanzó a detener), repetir el paso 3 con el worker ya detenido.
- Si el panel no abre: el comando `curl.exe ... | ConvertFrom-Json` del escenario 5, paso 1, da `messages_ready` (se actualiza cada 5 s).
- Si no se deja ver el contenido desde la interfaz, el panel no es imprescindible: la línea `📥 …` del worker y el escenario 5 demuestran lo mismo.

---

## 5. ScyllaDB: persistencia con `cqlsh`

**Objetivo.** Mostrar que los eventos quedaron guardados, que se leen del más reciente al más antiguo y por qué la tabla está diseñada así.

**Pasos.** En la 4.ª terminal:

1. Comprobar que la cola está en 0 (el worker ya guardó todo):

   ```powershell
   curl.exe -s -u guest:guest "http://localhost:15672/api/queues/%2F/eventos-seguridad"
   ```

   La respuesta es un JSON largo; para ver solo lo importante:

   ```powershell
   curl.exe -s -u guest:guest "http://localhost:15672/api/queues/%2F/eventos-seguridad" | ConvertFrom-Json | Select-Object messages_ready, messages_unacknowledged, consumers
   ```

   Debe dar `messages_ready : 0` y `consumers : 1` (o mirar el panel: Ready 0).
2. Entrar a `cqlsh`:

   ```powershell
   docker exec -it pickaroo-scylladb cqlsh
   ```

3. Los últimos eventos. La instrucción del guion es `SELECT * FROM auditoria.logs_eventos;`, pero la tabla ya tiene cientos de filas de pruebas: usar `LIMIT`.

   ```sql
   EXPAND ON;
   SELECT * FROM auditoria.logs_eventos LIMIT 3;
   EXPAND OFF;
   ```

   Sin `EXPAND ON` cada fila mide más de 200 caracteres y se parte en la pantalla; con `EXPAND ON` cada fila sale en vertical (`fecha_dia`, `tipo_evento`, `timestamp`, `evento_id`, `actor_id`, `actor_role`, `category`, `ip`, `metadata`, `reason`, `success`, ...). Si se escribe el `SELECT *` literal sin `LIMIT`, `cqlsh` trae todas las filas de la tabla (más de mil con los datos de prueba) y pagina; no se probó en una terminal interactiva: si pide continuar, `q` o Ctrl+C sale.
4. La consulta cronológica (la pregunta que manda el diseño: "los `LOGIN_FAILED` de hoy"):

   ```sql
   SELECT timestamp, actor_role, reason, metadata
   FROM auditoria.logs_eventos
   WHERE fecha_dia = toDate(now()) AND tipo_evento = 'LOGIN_FAILED'
   LIMIT 5;
   ```

   `fecha_dia` es la fecha **UTC**, no la de México: después de las 18:00 hora local ya es el día siguiente en UTC. `toDate(now())` usa la fecha UTC de ahora y evita el problema; también se puede escribir la fecha (`'2026-11-18'`). Salida real (la fila de arriba es la que se provocó en el escenario 4):

   ```
    timestamp                       | actor_role | reason                | metadata
   ---------------------------------+------------+-----------------------+------------------------------------------
    2026-11-18 06:20:11.961000+0000 |      ADMIN | Contraseña incorrecta |           {"email":"admin@carnyfrut.mx"}
    2026-11-18 06:08:40.466000+0000 |       null |  Correo no registrado | {"email":"nadie-918cfd2e@pickaroo.test"}
    2026-11-18 06:08:40.413000+0000 |      ADMIN | Contraseña incorrecta |           {"email":"admin@carnyfrut.mx"}
   ```

   Las filas salen **de la más reciente a la más antigua** sin `ORDER BY` ni `ALLOW FILTERING`. También sirven `'ROLE_CHANGED'`, `'USER_REGISTERED'` o `'LOGIN_SUCCESS'` en lugar de `'LOGIN_FAILED'`.
5. El diseño de la tabla:

   ```sql
   DESCRIBE TABLE auditoria.logs_eventos;
   ```

   Lo importante de la salida:

   ```
   PRIMARY KEY ((fecha_dia, tipo_evento), timestamp, evento_id)
   ) WITH CLUSTERING ORDER BY (timestamp DESC, evento_id DESC)
   ```

   - `(fecha_dia, tipo_evento)` es la **clave de partición**: toda la respuesta de "tipo X en el día Y" vive en una sola partición, y una partición solo guarda un tipo de un día (acotada).
   - `timestamp` y `evento_id` (timeuuid) son el **clustering**: ordenan por hora y desempatan eventos del mismo instante.
   - `DESC` deja lo más reciente primero en el disco, sin ordenar en memoria.
6. Salir con `exit`.

Lo mismo en una sola línea (sin entrar a `cqlsh`, para copiar y pegar):

```powershell
docker exec pickaroo-scylladb cqlsh -e "SELECT timestamp, actor_role, reason, metadata FROM auditoria.logs_eventos WHERE fecha_dia = toDate(now()) AND tipo_evento = 'LOGIN_FAILED' LIMIT 5;"
docker exec pickaroo-scylladb cqlsh -e "EXPAND ON; SELECT * FROM auditoria.logs_eventos LIMIT 2;"
docker exec pickaroo-scylladb cqlsh -e "DESCRIBE TABLE auditoria.logs_eventos;"
```

**Qué decir.** "La pregunta de negocio es 'qué eventos de tipo X hubo el día Y'. La tabla se diseñó para contestar solo esa pregunta: la clave de partición `(fecha_dia, tipo_evento)` deja la respuesta en un solo nodo y el orden `DESC` entrega lo más reciente primero. Además la escritura es idempotente: el `evento_id` se deriva del `eventId` del productor y un mensaje reentregado reescribe la misma fila."

**Plan B.**

- `Connection error` o `NoHostAvailable`: ScyllaDB aún arranca (D.3).
- `Keyspace 'auditoria' does not exist`: el worker no ha arrancado nunca; levantar la terminal 1 y reintentar (D.5).
- La hora local no coincide con la columna `timestamp`: la columna está en UTC (`+0000`).
- Si la tabla sale vacía para hoy, provocar un `LOGIN_FAILED` (escenario 4, paso 3) y repetir; tarda segundos.

---

## 6. Fail-safe: RabbitMQ se cae y la API sigue

**Objetivo.** Probar que la telemetría es asíncrona: sin broker, login y consultas siguen funcionando, la API avisa una sola vez y reconecta sola.

**Pasos.**

1. Dejar a la vista las terminales 1 (worker) y 2 (mongoAPI).
2. En la 4.ª terminal:

   ```powershell
   docker stop pickaroo-rabbitmq
   ```

   Tarda unos 2 s.
3. Terminal 2 (mongoAPI), una única línea, aunque se hagan varias peticiones:

   ```
   ⚠️  RabbitMQ no disponible (canal cerrado). Los eventos de seguridad se omiten hasta reconectar; la API sigue funcionando.
   ```

   Terminal 1 (worker), cada 5 s:

   ```
   ⚠️  Canal de RabbitMQ cerrado. Reintento en 5s.
   ⚠️  RabbitMQ no disponible (ECONNREFUSED). Reintento en 5s.
   ```

4. En Sandbox, con RabbitMQ apagado, seguir funcionando:
   - Login (`Login` con `empleado@carnyfrut.mx`): responde el token normalmente (unos 130 ms).
   - Una lectura transaccional: `query { products(limit: 3) { name stock } }` (con o sin sesión) y `query { myMenu { title } }`.
   - Terminal 2: el login imprime `🔑 Sesión iniciada: ...` como siempre.
5. Encender de nuevo:

   ```powershell
   docker start pickaroo-rabbitmq
   ```

6. Esperar. Aparecen dos líneas:

   - Terminal 2: `🔁 RabbitMQ reconectado. Cola "eventos-seguridad" lista.`
   - Terminal 1: `📥 Consumiendo la cola "eventos-seguridad" hacia ScyllaDB (prefetch 50).`

   **Tiempos medidos** (desde `docker start`): RabbitMQ tarda unos 10 s en aceptar conexiones; el worker reconectó a los 11.6 s y la API a los 17.4 s tras una caída de 12 s; tras una caída de 30 s, las dos a los 27 s. Decir "entre 10 y 30 segundos". Mientras RabbitMQ arranca, el worker puede imprimir `Socket closed abruptly during opening handshake`: es normal.
7. Comprobar que vuelve a fluir: `Login` con contraseña mala en Sandbox; el worker imprime `📥 [SECURITY] LOGIN_FAILED ...` y la fila aparece en ScyllaDB (escenario 5, paso 4).

**Qué decir.** "Es telemetría, no una cola de negocio: con el broker caído la petición no se retrasa ni falla; el evento se descarta con un solo aviso y el productor reconecta con espera exponencial (1, 2, 4... hasta 30 s). Los eventos de la ventana de caída se pierden por diseño."

**Plan B.**

- Si RabbitMQ no vuelve: `docker start pickaroo-rabbitmq` otra vez y `docker logs --tail 20 pickaroo-rabbitmq`. Nunca usar `docker compose down -v` (borra los datos).
- Si la API no reconecta tras un minuto: reiniciar la terminal 2 (`Ctrl+C`, `npm run dev:campamentos`).
- Si se agota el tiempo, mostrar solo los pasos 2 a 4 y decir cuánto tarda la reconexión (se ensayó antes).

---

## C. Reiniciar el estado después y entre ensayos

Todo lo de esta guía se puede repetir sin limpiar nada. Lo que deja huella y cómo revertirlo:

| Acción | Huella | Cómo se revierte |
|---|---|---|
| Logins (correctos o fallidos) | filas `LOGIN_*` en ScyllaDB | nada: la bitácora es inmutable y es lo que se quiere mostrar |
| `setProductStock` al mismo valor | evento `STOCK_SET`; el stock no cambia | nada |
| `assignRole` de `defensa@demo.mx` | eventos `ROLE_CHANGED` | dejar siempre al usuario en `CUSTOMER` (último paso del escenario 4); comprobar con `login` → `access.role` |
| `createUser` de `defensa@demo.mx` | un usuario más | se crea una sola vez; las veces siguientes responde `EMAIL_ALREADY_REGISTERED` (normal) |
| `docker stop` de RabbitMQ | eventos perdidos mientras estuvo caído | `docker start pickaroo-rabbitmq` |
| Worker detenido | mensajes en la cola | arrancar el worker: los drena |

Después de un ensayo: las tres terminales siguen vivas (reiniciar solo la que se detuvo), la cola `eventos-seguridad` en `Ready 0` con `Consumers 1` y los 5 contenedores arriba.

Nunca: `docker compose down -v`, borrar volúmenes, `Purge` o `Delete` de la cola ni borrar el keyspace `auditoria`.

---

## D. Solución de problemas

**D.1 Docker no está corriendo** (`error during connect`, `The system cannot find the file specified`): abrir Docker Desktop, esperar a que esté en verde y repetir `docker compose up -d`.

**D.2 Puerto ocupado** (`EADDRINUSE`, `port is already allocated`): ver quién lo usa y cerrarlo.

```powershell
netstat -ano | findstr :4000
taskkill /PID <pid> /T /F
```

Puertos de la guía: 4000, 4001, 4003 (API), 7474 y 7687 (Neo4j), 5672 y 15672 (RabbitMQ), 9042 (ScyllaDB), 27017, 6379. Un `node` huérfano de un ensayo anterior es la causa más común: `taskkill /T /F` sobre su PID (los `node --watch` hay que cerrarlos con `/T`, el árbol completo).

**D.3 ScyllaDB todavía arrancando** (`cqlsh`: `Connection error`/`NoHostAvailable`; el worker no imprime `ScyllaDB conectado`): tarda cerca de 1 minuto tras `docker compose up -d`. Repetir `docker exec pickaroo-scylladb cqlsh -e "DESCRIBE KEYSPACES;"` hasta que responda (en `docker logs pickaroo-scylladb` aparece `initialization completed`). El worker reintenta solo y empieza a consumir cuando está listo; los eventos esperan en RabbitMQ.

**D.4 Menú vacío (`myMenu: []`) o grafo sin menú.** Pasa si otra copia de la API anterior a la migración de `MenuItem` a `MenuNode` comparte el Neo4j. Cerrar esa copia y reiniciar la terminal 2 (`Ctrl+C`, `npm run dev:campamentos`): reescribe el catálogo y debe imprimir `Catálogo RBAC listo en Neo4j: 5 roles, 9 permisos, 12 rutas, 16 elementos de menú`. Verificar con `MATCH (m:MenuNode) RETURN count(m)` (16).

**D.5 Un `.env` viejo cambia la cola o el keyspace.** Revisar `services/mongoAPI/.env` y `services/auditAPI/.env`: borrar o corregir las líneas `RABBITMQ_QUEUE=pickaroo.events` y `SCYLLADB_KEYSPACE=pickaroo_audit`. Mientras estén, mandan sobre los valores por omisión: los mensajes irían a una cola que nadie mira y el worker escribiría en otro keyspace. Comprobar en los logs de arranque que salgan `Cola "eventos-seguridad"` (terminales 1 y 2) y `Keyspace "auditoria"` (terminal 1). Después de corregir, reiniciar las terminales 1 y 2.

**D.6 `UNAUTHENTICATED` en una operación que antes funcionaba.** El token dura 1 hora y un cambio de rol revoca las sesiones de ese usuario. Hacer login otra vez y actualizar el header.

**D.7 Sandbox no carga o queda en blanco.** Su interfaz viene de un CDN de Apollo: necesita Internet. Sin Internet, usar los fragmentos de PowerShell del escenario 2 (Plan B).

**D.8 Neo4j Browser no conecta.** Revisar que `docker ps` muestre `pickaroo-neo4j`; la contraseña es la de `NEO4J_AUTH` en `docker-compose.yml`. Si `http://localhost:7474/` responde un JSON con `neo4j_version`, el servidor está bien y el problema es la contraseña.

**D.9 `curl` en PowerShell.** `curl` es un alias de `Invoke-WebRequest`; escribir `curl.exe`.

**D.10 El panel de RabbitMQ no muestra el cambio.** Los contadores van con unos 5 segundos de retraso: esperar o recargar la página.
