# Dots con NVIDIA

Agentes personales con chat, memoria y rutinas persistentes. Implementación independiente basada en [Open Dots](https://github.com/Anil-matcha/open-dots), con licencia MIT. La procedencia y el commit importado están en [UPSTREAM.md](UPSTREAM.md); se conserva la documentación original en [README.upstream.md](README.upstream.md).

La referencia del producto es [Introducing Dots, de OpenAI](https://openai.com/es-ES/index/introducing-dots/). Se consultó también [Awesome Dots](https://github.com/mergisi/awesome-dots), una recopilación no oficial, porque el artículo devolvía HTTP 403 desde esta máquina. Esto reconstruye parte de sus funciones; no contiene el código privado ni reproduce toda la infraestructura o todas las integraciones de ChatGPT.

## Incluido

- Interfaz de chat con varios agentes, avatares y respuestas en streaming.
- [Trabajo en equipo](TEAM-AND-APP.md): de dos a cuatro Dots aportan, revisan las ideas de sus compañeros y entregan una respuesta final del coordinador.
- Temas Liquid Glass, acentos, espaciado y control de animaciones; [instalación en la pantalla de inicio del iPhone](TEAM-AND-APP.md) con icono de cristal transparente.
- [Conectores guiados](CONNECTORS.md): el chat descubre y utiliza las acciones reales de Gmail, Calendar, Drive, Notion, Slack, GitHub y las demás cuentas autorizadas. Los envíos y cambios requieren revisión de sus datos. YouTube permite preparar, revisar y subir vídeos al canal.
- NVIDIA NIM mediante `/v1/chat/completions`, autenticación Bearer y llamadas a herramientas. Los modelos mantienen su ID exacto.
- Modelo predeterminado `nvidia/nemotron-3-super-120b-a12b`, observado en el catálogo público de NVIDIA el 6 de octubre de 2026. Puedes cambiarlo en Ajustes → Proveedor de IA y en el selector de cada agente.
- Memoria por agente en SQLite: añadir, consultar y borrar preferencias. Se incluye en futuras conversaciones y rutinas. El agente puede guardar un recuerdo con la herramienta `remember`.
- Rutinas inmediatas, futuras y recurrentes. Un trabajador del servidor reclama cada ejecución de forma atómica, guarda su resultado y lo entrega al chat. Siguen funcionando al cerrar la pestaña, mientras el servidor siga encendido.
- Programar rutinas desde el chat con aprobación del usuario; pausar, reanudar, ejecutar ahora y eliminar rutinas. Los errores detienen la repetición; un reinicio informa las ejecuciones interrumpidas y no las repite a ciegas.
- Reglas personalizadas por agente en Ajustes y actividad auditable.
- Ordenador por agente en Docker con Chromium: visitar páginas y leer texto y enlaces, ejecutar comandos, capturar pantalla y operar teclado/ratón mediante la API. Las acciones de navegador, archivos y terminal pasan por el control de permisos.
- Claves cifradas en el servidor y sesión de propietario con cookie HttpOnly; las claves del modelo no se envían al cliente.
- [Copias cifradas en GitHub](PERSISTENCE.md): recuperación automática de claves, recuerdos, rutinas, equipos y sesión de WhatsApp cuando el disco del alojamiento se pierde.

## Arranque

La sección **Llamadas y WhatsApp → WhatsApp → Con QR** permite vincular tu móvil sin Twilio: elige un Dot, escanea el QR desde Dispositivos vinculados y escríbele en «Mensaje a ti mismo». También puedes conectar un número aparte para el Dot. Las llamadas y la conexión oficial con Twilio siguen disponibles. Consulta [COMMUNICATIONS.md](COMMUNICATIONS.md) para la configuración y los límites.

Para alojar tu espacio privado desde GitHub, consulta [DEPLOY.md](DEPLOY.md). Incluye un despliegue en el plan gratuito de Render, con acceso de propietario y una demo pública opcional desactivada por defecto. La publicación requiere crear la cuenta de alojamiento.

Requisitos: Linux con Docker activo, Python 3.12 y `uv`, Node 22 o superior y npm. En este entorno se validaron Python 3.12 y Node 24. Cada tarea de nube ya está aislada: utiliza el checkout existente; no necesitas crear un Git worktree.

Desde la raíz:

```bash
bash scripts/install.sh
bash scripts/dev.sh
```

La instalación usa los lockfiles de npm y Python, comprueba hashes de paquetes Python y construye el ordenador desde una imagen de Node fijada por digest y paquetes oficiales de Debian. El helper de Docker reutiliza el proxy y las autoridades certificadoras del entorno; mantiene la comprobación TLS, las firmas de Debian y los checksums de las imágenes.

`dev.sh` ejecuta una API en el puerto 8000 y Next.js en el 3000, enlazados a loopback. La API inicia el conector privado de WhatsApp en el puerto 8787; espera a que termine el arranque. La página de inicio redirige a `/app`. La interfaz usa `/api/v1` en el mismo origen y Next.js lo dirige al backend. Usa `API_INTERNAL_URL` si el backend está en otra ubicación. Al cerrar el script se detienen únicamente sus procesos, incluido el conector.

Para identificarte, consulta **localmente y en privado** `server/.data/.auth-token` e introdúcelo en el formulario. No es tu clave de NVIDIA. También puedes establecer `APP_AUTH_TOKEN` en el servidor antes de arrancar. No publiques el token ni lo incluyas en variables `NEXT_PUBLIC_*`.

## Clave de NVIDIA

En Codex, añade el valor de `NVIDIA_API_KEY` en los ajustes seguros del entorno, guarda los cambios y publica el entorno preparado. El borrador contiene el requisito de esa clave y su destino `integrate.api.nvidia.com`; nunca contiene su valor. Reinicia la API tras incorporar una variable nueva.

Fuera de Codex, copia `.env.example` a `.env` e introduce la clave **en ese archivo local ignorado**, o configúrala en Ajustes → Proveedor de IA. El botón **Usar NVIDIA NIM** establece la URL y el protocolo. Guarda el proveedor y elige el mismo modelo en los agentes que quieras actualizar.

No hay respuestas de IA simuladas cuando falta una clave. El chat informa del requisito y las rutinas pasan a Error. La accesibilidad del catálogo público no verifica inferencia autenticada: necesita tu clave, crédito y acceso al modelo. Cada tarea recurrente puede consumir cuota de NVIDIA.

## Memoria y rutinas

Selecciona un agente y abre Memoria para guardar preferencias; también puedes pedirle «recuerda que prefiero respuestas breves en español». Abre Rutinas para delegar trabajo, escribir su instrucción y elegir fecha y repetición. Una fecha vacía ejecuta la tarea cuanto antes. El navegador convierte la hora local a una fecha con zona horaria; los intervalos recurrentes se calculan desde el final de la última ejecución y no equivalen a horarios de calendario con cambios de hora.

Los resultados se guardan y aparecen en el chat, que se actualiza periódicamente cuando no está generando una respuesta. Las rutinas usan la memoria y el modelo del agente y tienen acceso a búsqueda web, pero **no** a escrituras, terminal o navegación que necesiten aprobación. Las conversaciones interactivas sí pueden solicitar esas herramientas. El bucle está limitado a seis rondas y las rutinas a diez minutos por ejecución.

Ejecuta **una sola instancia de la API, con un solo worker**: las sesiones y los permisos están en memoria. SQLite conserva rutinas, recuerdos, mensajes, ajustes y actividad en `server/.data/`. Conserva este directorio y su clave de cifrado para mantener los datos. Los contenedores de ordenador pueden reconstruirse; sus archivos están en `server/.data/computers/`. Los procesos no sobreviven a una restauración de la nube y deben volver a arrancar.

## Comprobaciones

```bash
cd server
DATA_DIR=/tmp/dots-tests COMPUTER_PROVIDER=fake .venv/bin/python -m unittest discover -s tests -q
cd ../client
npm run build
```

La suite incluye autenticación, cifrado, permisos, proveedores, comandos, streams de NVIDIA, herramientas y persistencia/ejecución de rutinas. Los tests de inferencia usan un transporte controlado: no gastan tu cuota y no demuestran una llamada real con tu cuenta.

Comprueba también `/api/v1/health`, el formulario de acceso, guardar y borrar un recuerdo, crear una rutina, revisar su resultado en el chat y abrir el ordenador del agente. La prueba funcional de IA requiere la clave real y la prueba de búsquedas requiere acceso al servicio correspondiente.

## Servicios opcionales y límites

La búsqueda utiliza `api.you.com/mcp` mediante el perfil gratuito sin clave. `YDC_API_KEY` permite usar el servicio autenticado; disponibilidad y límites dependen de You.com. Los [conectores guiados](CONNECTORS.md) usan Composio: guarda su clave desde la interfaz y autoriza cada cuenta. `COMPOSIO_API_KEY` permite configurar esa clave por variables. Ninguna cuenta externa está conectada automáticamente. Su catálogo no significa que todas las acciones de cada aplicación estén implementadas.

No incluye clientes nativos, Slack/Teams como canales de conversación, 4000 integraciones, acceso al ordenador personal ni la memoria de ChatGPT. El ordenador usa un contexto de navegador efímero por contenedor; no hereda tus sesiones personales. Docker aporta separación y límites de recursos, pero esta versión no es un servicio multiusuario ni una solución de aislamiento para páginas hostiles.

Para exponerlo fuera de loopback, configura un reverse proxy HTTPS, `AUTH_COOKIE_SECURE=1` y `CORS_ORIGINS` con el origen exacto de la interfaz. No abras la API, el socket Docker ni los puertos de los ordenadores directamente a Internet.

## Validación en este entorno

235 pruebas de la API y del arranque de producción y 12 del servicio de WhatsApp pasadas, y compilación de producción completada. Se comprobó una tarea real con NVIDIA: dos Dots aportaron análisis, revisaron las ideas del otro y entregaron una síntesis del coordinador. El modelo real también descubrió Gmail, eligió una acción conforme a su esquema y resumió los correos de prueba que devolvió el adaptador controlado; no se accedió a una cuenta de correo externa ni se enviaron mensajes. Las credenciales siguen cifradas y los datos temporales de prueba se eliminaron.

Las comprobaciones de navegador cubrieron temas guardados y previsualizados, equipos, conectores, revisión de vídeos, navegación móvil y la instalación web. El contenedor final funcionó con un límite de 512 MB, sin reinicios ni errores JavaScript. Las API privadas rechazaron visitantes anónimos y el service worker almacenó solo el icono y la página sin conexión.

Se reprodujo el caso de WhatsApp QR conectado con solo Gmail en Composio. El modelo real de NVIDIA corrigió la respuesta anterior equivocada y eligió el envío QR al propietario. La aprobación, el destinatario, la deduplicación, los cambios de sesión y los errores se probaron con sockets y transportes controlados; no se enviaron mensajes a teléfonos reales.

La autorización y publicación de YouTube se comprobaron con respuestas controladas y el contrato oficial del proveedor; no se autorizó un canal real ni se publicó un vídeo. La instalación se comprobó con emulación de iPhone, sin una instalación física en el dispositivo. Esta versión necesita desplegarse en Render desde el último commit para actualizar la web pública.

La recuperación desde GitHub se verificó con un proveedor controlado: tras borrar el disco local se recuperaron claves, memoria, rutinas, equipos, identidad de conectores y una sesión real de la librería de WhatsApp. También se comprobó el arranque en un proceso nuevo, la restauración interrumpida, la exportación cifrada y los controles privados. No se activaron copias contra un repositorio remoto real; requieren configurar el token de GitHub y las variables de recuperación en el alojamiento.
