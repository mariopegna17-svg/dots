# Conectores y publicación en YouTube

Abre **Conectores** en la barra lateral. La configuración se hace en esa pantalla; no necesitas buscar variables de Render ni pegar otra clave de NVIDIA.

## Configurar una vez

1. Abre [Composio](https://dashboard.composio.dev/settings), crea una cuenta y copia una API key de tu proyecto.
2. En **Conectores → Clave de Composio**, pega esa clave y pulsa **Guardar clave**. La aplicación comprueba que el proveedor la acepta y la guarda cifrada.
3. Pulsa **Conectar** en una aplicación y autoriza tu cuenta en la pestaña que se abre. Dots detecta la conexión automáticamente. Si el navegador bloquea la pestaña, usa **Abrir conexión**.

La clave de NVIDIA sirve para la inferencia de los Dots. La clave de Composio sirve para las cuentas de aplicaciones. Se guardan por separado. También puedes suministrar `COMPOSIO_API_KEY` como secreto del alojamiento si prefieres configurar por variables.

Cada instalación utiliza una identidad propia en Composio. Si habías conectado una cuenta con la versión antigua, autorízala de nuevo desde esta pantalla. Las conexiones de otro usuario o de otra instalación no se reutilizan automáticamente.

YouTube y GitHub tienen acciones implementadas. Las demás aplicaciones permiten vincular una cuenta; sus acciones aún no están integradas en el agente. WhatsApp tiene su propia conexión por QR en **Llamadas y WhatsApp** y no requiere Composio.

## Subir un vídeo a YouTube

1. Pulsa **Conectar YouTube** y autoriza con Google la cuenta y el canal que quieras usar. Dots solicita permiso para consultar tu canal y subir vídeos. No necesitas entregar tu contraseña de Google a Dots.
2. Comprueba el nombre del canal que aparece en la tarjeta. Si no tienes un canal, créalo primero en YouTube. Utiliza una única cuenta/canal en esta conexión.
3. Pulsa **Añadir vídeo**, selecciona un archivo **MP4, MOV o WebM de hasta 50 MB** y rellena título y descripción.
4. Elige visibilidad: **Privado** (predeterminada), **Oculto** o **Público**. Indica expresamente si el vídeo está creado para niños.
5. Pulsa **Revisar subida**. Este paso prepara un archivo temporal en el servidor; todavía no publica en YouTube.
6. Revisa canal, archivo, título, descripción, público infantil y visibilidad. Pulsa **Confirmar y subir** para enviar el vídeo. El progreso y el enlace real aparecen en la tarjeta.

Puedes pulsar **Guardar borrador** en la revisión y después pedir a un Dot «Sube a YouTube el borrador que he preparado». El Dot consulta los borradores reales y propone una aprobación en el chat con los datos concretos del vídeo. La tarea no se ejecuta hasta que apruebes esa tarjeta. Las tareas de fondo y los equipos de Dots no pueden publicar vídeos.

Los borradores caducan después de una hora. El archivo temporal se elimina al terminar, fallar, descartar o caducar. Se permiten hasta tres vídeos preparados y una subida simultánea por instalación. Una confirmación repetida no vuelve a subir el mismo borrador. Si el servidor se reinicia durante una subida, se informa de la interrupción y no se reintenta automáticamente: revisa YouTube Studio antes de subir otra copia.

El envío usa el protocolo de subida reanudable de YouTube a través del proxy autenticado de Composio. El fichero se transmite por fragmentos; los tokens de Google no llegan al navegador. El progreso corresponde a los bytes aceptados por YouTube, y completar la transferencia no implica que haya terminado el procesamiento del vídeo.

## Permisos, privacidad y cuotas

- La autorización de Google es necesaria: guardar la API key de Composio no conecta tu canal por sí solo.
- Si YouTube rechaza el permiso, desconecta y vuelve a conectar YouTube para renovar la autorización de subida.
- Composio tiene sus propios planes y cuotas. YouTube aplica tanto cuotas de API como límites diarios de vídeos por canal. No se promete uso ilimitado.
- Los proyectos de API de YouTube sin verificar pueden limitar las subidas a privadas, aunque solicites público. Dots muestra la privacidad devuelta por YouTube. Para cuotas propias o uso de producción, configura tus credenciales OAuth de Google en Composio: [guía de credenciales de Google](https://composio.dev/auth/googleapps). Dots usa tu configuración personalizada si hay una única activa; con varias, nombra la elegida `Open Dots · youtube · uploads`. Incluye los permisos `youtube.upload` y `youtube.readonly`.
- En Render Free el servidor puede dormirse y perder su almacenamiento al reiniciar o desplegar. Los borradores y el historial no tienen persistencia garantizada.

Referencia del contrato utilizado: [API de Composio](https://github.com/ComposioHQ/composio/blob/master/docs/public/openapi-v3.json), [proxy de herramientas](https://docs.composio.dev/reference/api-reference/tools/postToolsExecuteProxy) y [protocolo de YouTube](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol).
