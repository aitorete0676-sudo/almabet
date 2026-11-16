# AlmaBet en Vercel: cómo ponerlo en marcha

Solo necesitas **GitHub** (guarda el código) y **Vercel** (la web y la base de datos). Ya no hace falta Supabase. Unos 10 minutos, gratis.

## 1. GitHub: subir el código

1. Crea una cuenta en github.com.
2. Pulsa **+ > New repository**. Nombre: `almabet`. Pulsa **Create repository**.
3. Pulsa **uploading an existing file** y arrastra **todo lo que hay dentro de la carpeta `web`**, incluida la carpeta `api`.
4. Pulsa **Commit changes**.

## 2. Vercel: publicar la web

1. Entra en vercel.com con **Continue with GitHub**.
2. **Add New > Project**, elige `almabet` y pulsa **Import**.
3. No toques nada y pulsa **Deploy**. Sale un enlace tipo `almabet-xxxx.vercel.app`.

## 3. Vercel: la base de datos (cuentas y saldos)

1. Dentro del proyecto, pestaña **Storage > Create Database**.
2. Elige **Upstash for Redis** (plan gratis) y pulsa **Create**. Cuando pregunte, conéctala al proyecto `almabet`. Si ya tienes una base de datos gratis de otra app (por ejemplo `bebagua-db`), conecta esa: AlmaBet guarda todo con el prefijo `ab:` y no se mezcla.
3. Ve a **Deployments**, en el último pulsa **⋯ > Redeploy**. Así la web ya ve la base de datos.

## 4. Tus dos cuentas: administrador y jugador

Hay dos direcciones. Cada una recuerda su propia sesión:

- `tu-enlace.vercel.app/admin` → cuenta de **administrador** (icono con banda roja ADMIN).
- `tu-enlace.vercel.app` → cuenta de **jugador**.

1. Abre `/admin` y crea **la primera cuenta**, por ejemplo `admin`. La primera que se registra es la del administrador: mete resultados, goles y tarjetas, no apuesta y no sale en el ranking.
2. Añádela a la pantalla de inicio (ver paso 5). Saldrá como **AB Admin**.
3. Abre el enlace normal, crea tu cuenta de jugador (por ejemplo `aitor`) y añádela también. Saldrá como **AlmaBet**.

Tus compañeros solo usan el enlace normal.

## 5. Acceso directo en el móvil

Pasa el enlace por el grupo del equipo. Cada uno:

- **iPhone (Safari):** Compartir > **Añadir a pantalla de inicio**.
- **Android (Chrome):** menú ⋮ > **Instalar aplicación** o **Añadir a pantalla de inicio**.

Cada uno crea su cuenta, empieza con 1.000 € ficticios y en **Ranking** se ve quién va ganando.

## Qué hay en la carpeta

| Fichero | Para qué sirve |
|---|---|
| `index.html` | La app entera |
| `api/almabet.js` | El servidor: cuentas, saldos y partidos |
| `config.js` | Dice a la app dónde está el servidor |
| `manifest.json`, `manifest-admin.json`, `sw.js`, `*.png` | Que se instale como app con su icono (normal y admin) |
| `vercel.json` | Que no se quede con versiones viejas |
| `build.py` | Para Claude: regenera `index.html` |

## A tener en cuenta

- Dinero ficticio entre amigos. Alguien que sepa programar podría tocarse su saldo. Si hace falta, se blinda pasando el cobro de apuestas al servidor.
- Las contraseñas se guardan cifradas (scrypt). Nadie las ve.
- Si te equivocaste y otro se registró antes que tú: en Vercel, **Settings > Environment Variables**, añade `ADMIN_USER` con tu usuario y haz Redeploy.
