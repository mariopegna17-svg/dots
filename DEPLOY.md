# Publicar gratis desde GitHub

Para recuperar claves, memoria, rutinas, equipos y WhatsApp después de perder el disco, activa las [copias cifradas en el propio repositorio](PERSISTENCE.md). Render necesita un token de GitHub limitado al repositorio; la clave de recuperación permanece en sus variables de entorno.

[Desplegar en Render](https://render.com/deploy?repo=https://github.com/mariopegna17-svg/dots)

1. Crea una cuenta de Render con GitHub y autoriza el repositorio.
2. Usa el enlace anterior. El archivo `render.yaml` propone un único servicio Docker con plan **Free**, sin disco de pago ni servicios adicionales. Revisa que el panel conserve ese plan antes de crear el servicio; los planes y requisitos de Render pueden cambiar.
3. Introduce `NVIDIA_API_KEY` únicamente en el campo secreto de Render. La clave cifrada en el entorno de Codex no se sube a GitHub ni se migra automáticamente al alojamiento.
4. Espera al despliegue. Abre la URL HTTPS que Render asigna al servicio. La raíz redirige a tu espacio privado en `/app`; la dirección final se conoce al crear el servicio.
5. Introduce el valor generado de `APP_AUTH_TOKEN`, consultándolo en privado en las variables de Render. Nunca compartas ese token. El despliegue mantiene `PUBLIC_DEMO_ENABLED=0` para uso personal.

El arranque espera a que la API responda en `/api/v1/health` antes de abrir la web. Esto incluye la recuperación de las copias de GitHub; en los registros aparecerá `API ready. Starting the web.` cuando termine. Si la API falla o no está lista en tres minutos, el proceso termina con error para que Render pueda detectar el fallo; consulta los registros de la API. El apagado concede hasta 30 segundos a los procesos para guardar el estado y cerrar.

Después de reiniciar el servidor puede ser necesario volver a iniciar sesión: los `401 Unauthorized` anteriores al acceso son esperados. Si `POST /api/v1/auth/login` devuelve `200 OK` y las peticiones privadas siguientes también devuelven `200`, el acceso funciona. Para comprobar la API usa `/api/v1/health`; `HEAD /` en su puerto interno puede devolver `404` porque la página principal la sirve Next.js.

## Qué ofrece el enlace público

Para conversar por WhatsApp, abre **Llamadas y WhatsApp → WhatsApp → Con QR**, elige tu Dot y vincula el móvil desde **Dispositivos vinculados**. No necesita Twilio ni nuevas variables de entorno. La conexión por QR es no oficial; puede desconectarse o causar bloqueos de cuenta. Las llamadas telefónicas y WhatsApp con Twilio siguen siendo opcionales y requieren sus credenciales. Consulta [COMMUNICATIONS.md](COMMUNICATIONS.md).

La demo pública está desactivada por defecto. Si decides compartirla más adelante, cambia `PUBLIC_DEMO_ENABLED` a `1` en el alojamiento. La raíz abrirá `/demo`. Ese chat utiliza NVIDIA, sin herramientas ni acceso a conversaciones, recuerdos, ajustes, archivos o rutinas del propietario. El historial público permanece en la pestaña del visitante y se envía al proveedor para responder; no se guarda en las conversaciones privadas. Hay 20 consultas diarias en total, compartidas entre visitantes, y un máximo de dos respuestas simultáneas. El presupuesto se cuenta en SQLite antes de llamar al proveedor; una petición fallida también consume una consulta. El proveedor puede facturar o descontar cuota por esas consultas aunque el alojamiento sea gratuito.

La sección privada conserva los agentes, memoria y rutinas, protegidos por el token. Esta versión sigue siendo de un único propietario; no ofrece cuentas independientes para visitantes.

El **Equipo de Dots**, los **temas** y la instalación en iPhone funcionan con el mismo servicio. Consulta [TEAM-AND-APP.md](TEAM-AND-APP.md). Para subir vídeos, configura **Conectores → YouTube** y autoriza tu canal siguiendo [CONNECTORS.md](CONNECTORS.md). No necesitas nuevas variables obligatorias de Render; la clave de Composio se puede guardar desde la web.

## Límites de la opción gratuita

Las instancias gratuitas pueden suspenderse y tardar en arrancar al recibir una visita. Mientras estén suspendidas las rutinas no se ejecutan y WhatsApp no responde. Abre la web para despertar el servicio antes de escribir al Dot. El disco local no tiene persistencia garantizada: activa las [copias de GitHub](PERSISTENCE.md) y verifica una copia confirmada para recuperar memoria, rutinas, conversaciones, ajustes y WhatsApp tras perder ese disco. Sin copia, esos datos pueden perderse y la sesión de WhatsApp necesita otro QR. No uses este plan para rutinas importantes ni como un límite de gasto infalible.

El ordenador Docker de los agentes necesita un servidor compatible. Este despliegue utiliza el adaptador remoto y no configura un servicio de ordenador: si se intenta iniciarlo mostrará un error explícito. El chat público no ofrece esa herramienta. Para toda la funcionalidad usa un VPS con Docker o configura un servicio compatible con `COMPUTER_REMOTE_BASE_URL` y su credencial.

La publicación requiere una cuenta de alojamiento y acceso al repositorio. Tener código en GitHub o un archivo de despliegue no significa que ya exista una web publicada.
