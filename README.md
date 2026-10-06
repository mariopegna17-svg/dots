# Dots con NVIDIA

Agentes personales con chat, memoria y rutinas persistentes. Implementación independiente basada en [Open Dots](https://github.com/Anil-matcha/open-dots), con licencia MIT. La procedencia y el commit importado están en [UPSTREAM.md](UPSTREAM.md); se conserva la documentación original en [README.upstream.md](README.upstream.md).

La referencia del producto es [Introducing Dots, de OpenAI](https://openai.com/es-ES/index/introducing-dots/). Se consultó también [Awesome Dots](https://github.com/mergisi/awesome-dots), una recopilación no oficial, porque el artículo devolvía HTTP 403 desde esta máquina. Esto reconstruye parte de sus funciones; no contiene el código privado ni reproduce toda la infraestructura o todas las integraciones de ChatGPT.

## Incluido

- Interfaz de chat con varios agentes, avatares y respuestas en streaming.
- NVIDIA NIM mediante `/v1/chat/completions`, autenticación Bearer y llamadas a herramientas. Los modelos mantienen su ID exacto.
- Modelo predeterminado `nvidia/nemotron-3-super-120b-a12b`, observado en el catálogo público de NVIDIA el 6 de octubre de 2026. Puedes cambiarlo en Ajustes → Proveedor de IA y en el selector de cada agente.
- Memoria por agente en SQLite: añadir, consultar y borrar preferencias. Se incluye en futuras conversaciones y rutinas. El agente puede guardar un recuerdo con la herramienta `remember`.
- Rutinas inmediatas, futuras y recurrentes. Un trabajador del servidor reclama cada ejecución de forma atómica, guarda su resultado y lo entrega al chat. Siguen funcionando al cerrar la pestaña, mientras el servidor siga encendido.
- Programar rutinas desde el chat con aprobación del usuario; pausar, reanudar, ejecutar ahora y eliminar rutinas. Los errores detienen la repetición; un reinicio informa las ejecuciones interrumpidas y no las repite a ciegas.
- Reglas personalizadas por agente en Ajustes y actividad auditable.
- Ordenador por agente en Docker con Chromium: visitar páginas y leer texto y enlaces, ejecutar comandos, capturar pantalla y operar teclado/ratón mediante la API. Las acciones de navegador, archivos y terminal pasan por el control de permisos.
- Claves cifradas en el servidor y sesión de propietario con cookie HttpOnly; las claves del modelo no se envían al cliente.

## Arranque

Para alojar tu espacio privado desde GitHub, consulta [DEPLOY.md](DEPLOY.md). Incluye un despliegue en el plan gratuito de Render, con acceso de propietario y una demo pública opcional desactivada por defecto. La publicación requiere crear la cuenta de alojamiento.

Requisitos: Linux con Docker activo, Python 3.12 y `uv`, Node 22 o superior y npm. En este entorno se validaron Python 3.12 y Node 24. Cada tarea de nube ya está aislada: utiliza el checkout existente; no necesitas crear un Git worktree.

Desde la raíz:

```bash
bash scripts/install.sh
bash scripts/dev.sh
```

La instalación usa los lockfiles de npm y Python, comprueba hashes de paquetes Python y construye el ordenador desde una imagen de Node fijada por digest y paquetes oficiales de Debian. El helper de Docker reutiliza el proxy y las autoridades certificadoras del entorno; mantiene la comprobación TLS, las firmas de Debian y los checksums de las imágenes.

`dev.sh` ejecuta una API en el puerto 8000 y Next.js en el 3000, enlazados a loopback. La página de inicio redirige a `/app`. La interfaz usa `/api/v1` en el mismo origen y Next.js lo dirige al backend. Usa `API_INTERNAL_URL` si el backend está en otra ubicación. Al cerrar el script se detienen únicamente sus procesos.

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

La búsqueda utiliza `api.you.com/mcp` mediante el perfil gratuito sin clave. `YDC_API_KEY` permite usar el servicio autenticado; disponibilidad y límites dependen de You.com. Los conectores heredados usan Composio y requieren `COMPOSIO_API_KEY` y los permisos/OAuth de cada cuenta. Ninguna cuenta externa está conectada automáticamente. Su catálogo no significa que todas las acciones de cada aplicación estén implementadas.

No incluye llamadas telefónicas, clientes nativos, Slack/Teams como canales de conversación, 4000 integraciones, acceso al ordenador personal ni la memoria de ChatGPT. El ordenador usa un contexto de navegador efímero por contenedor; no hereda tus sesiones personales. Docker aporta separación y límites de recursos, pero esta versión no es un servicio multiusuario ni una solución de aislamiento para páginas hostiles.

Para exponerlo fuera de loopback, configura un reverse proxy HTTPS, `AUTH_COOKIE_SECURE=1` y `CORS_ORIGINS` con el origen exacto de la interfaz. No abras la API, el socket Docker ni los puertos de los ordenadores directamente a Internet.

## Validación en este entorno

103 pruebas automatizadas pasadas y compilación de producción completada. Se verificaron en el navegador el acceso, memoria, rutinas y el fallo explícito al faltar una clave. El ordenador Docker abrió GitHub por HTTPS, leyó texto y enlaces, capturó pantalla y ejecutó un comando. La búsqueda gratuita de You.com respondió correctamente. También se verificaron la inferencia autenticada de NVIDIA, una respuesta real del chat por streaming y una rutina completada con el modelo predeterminado. La credencial se conserva cifrada en los ajustes de la aplicación y los elementos temporales de prueba se eliminaron. El contenedor de producción compiló y la demo pública respondió con NVIDIA desde el navegador, sin errores JavaScript; los ajustes privados devolvieron 401 al visitante anónimo. El despliegue en un alojamiento público y la restauración en una tarea nueva aún no se han realizado.
