# Llamadas y WhatsApp

## WhatsApp por QR: la conexión sencilla

No necesitas Twilio, tokens de WhatsApp, webhooks ni una cuenta de empresa. Baileys vincula Dots como un dispositivo de WhatsApp y tu modelo de NVIDIA genera las respuestas.

1. En Render, despliega la última versión de `main`: **Manual Deploy → Deploy latest commit**. Conserva `NVIDIA_API_KEY` y `APP_AUTH_TOKEN`. No necesitas nuevas variables para WhatsApp por QR.
2. Abre la web y entra en **Llamadas y WhatsApp → WhatsApp → Con QR**.
3. Elige el **Dot que responde**. Deja **Mi WhatsApp · Mensaje a ti mismo** para usar tu número actual.
4. Pulsa **Conectar WhatsApp**. En el móvil abre WhatsApp → **Ajustes** o menú **⋮** → **Dispositivos vinculados → Vincular un dispositivo** y escanea el QR que aparece en la web. El QR es privado; no lo compartas.
5. Cuando aparezca **WhatsApp conectado**, abre tu propio chat **Mensaje a ti mismo** en WhatsApp y escribe «Hola». El Dot responderá allí. Solo procesa mensajes de texto; no procesa notas de voz, archivos ni grupos.
6. Si prefieres un contacto aparte, elige **Otro número para el Dot**, introduce tu número habitual con prefijo internacional y escanea con el WhatsApp del otro número. El Dot responderá únicamente a tu número habitual. Abre la conversación mediante el botón que aparece al conectar.

Puedes cambiar el Dot con **Guardar cambios**. **Desconectar** cierra y borra la sesión local del bot; también puedes revocar el dispositivo desde WhatsApp. El conector no cobra por mensaje, pero el servicio de IA mantiene los límites y condiciones de tu API de NVIDIA. Baileys es una conexión no oficial y WhatsApp puede desconectar o bloquear una cuenta: conviene usar un número aparte si quieres separar el bot de tu cuenta habitual.

Con el QR conectado también puedes pedir desde el chat web «Envíame por WhatsApp cuánto es 2+2». El Dot comprueba la sesión y envía el mensaje a tu número automáticamente, sin pedir autorización con la configuración predeterminada. Puedes activar la revisión manual en **Ajustes → Envíos a mi WhatsApp**, desactivando **Enviar sin pedirme confirmación**; la preferencia queda guardada. En **Mi WhatsApp** lo recibes en **Mensaje a ti mismo**; con **Otro número para el Dot**, se envía a tu número habitual configurado. Esta conexión no aparece como una cuenta de Composio y no necesita Twilio ni una conversación abierta en las últimas 24 horas. Si cambia la sesión o el destinatario antes del envío, la acción se detiene. Los envíos por QR tienen un cupo propio de 200 solicitudes al día, separado de las diez llamadas o mensajes de Twilio, y aparecen en **Últimas comunicaciones**. El estado real muestra el cupo usado y restante. «Enviado» indica que WhatsApp aceptó el mensaje; esta conexión no confirma entrega ni lectura. Un envío incierto no se repite automáticamente, tampoco al reconectar o reiniciar el servidor.

Si eliges revisión manual, la tarjeta **Confirma el envío de WhatsApp** queda fija junto al cuadro de escritura de **este mismo chat**, incluso con un historial largo. Pulsa **Autorizar** después de revisar el destinatario y el texto. **Esperando tu autorización** significa que el envío todavía está pendiente de tu decisión; **Enviando a WhatsApp…** indica que ya está en curso. Si dejas caducar la solicitud, no hay una aprobación pendiente: pide el envío otra vez para recibir una nueva tarjeta. Recargar o ir a Llamadas y WhatsApp no recupera una autorización caducada. La preferencia automática se aplica a las peticiones nuevas; no ejecuta solicitudes antiguas caducadas.

Al pedir «Envíame por WhatsApp…», el Dot debe preparar una acción real para enviar y confirmar su resultado. También reconoce continuaciones de esa tarea como «envíamelo otra vez», «ahora envía cuánto es 3+3» o «haz lo mismo con 4+4», y consulta el texto y el resultado auditados del envío anterior. Una petición nueva puede enviar el mismo texto; reabrir el mismo stream no repite el envío. Puede consultar datos primero. Si el modelo no prepara la solicitud, el chat indica el problema y no se envía nada. En revisión manual, rechazar o dejar caducar un envío termina el turno, también si el modelo lo agrupó con otras herramientas; no se vuelven a generar instrucciones a partir de mensajes antiguos ni se continúan otras acciones de ese lote.

Las peticiones de WhatsApp y las respuestas por teléfono usan una generación breve de hasta 1024 tokens. Para el modelo predeterminado `nvidia/nemotron-3-super-120b-a12b` en la API oficial de NVIDIA se usa su [plantilla sin razonamiento extendido](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-super-120b-a12b). No se cambia el modelo elegido. Cuando el envío completa todo lo pedido, el chat confirma directamente el resultado del conector, sin otra consulta a la IA. Las solicitudes rechazadas o caducadas terminan sin proponer otros canales. El tiempo real sigue dependiendo del arranque del alojamiento, del proveedor y de WhatsApp.

**Render Free:** el servicio puede dormir sin visitas y dejar de contestar. Abre la web para despertarlo y espera a que muestre conectado. Activa las [copias cifradas en GitHub](PERSISTENCE.md) para recuperar la configuración, las credenciales y las claves Signal cuando Render borre el disco. Sin una copia confirmada, o si WhatsApp revoca la sesión, necesitas escanear de nuevo el QR. Las copias no garantizan disponibilidad continua mientras el servidor esté dormido.

El servidor de WhatsApp arranca automáticamente con la API y escucha solo en `127.0.0.1:8787`, protegido por una clave interna generada en cada arranque. No lo publiques ni añadas este puerto a un proxy. El QR y los controles requieren la sesión del propietario en la web. Las credenciales de WhatsApp, las claves Signal y la cola se guardan cifradas en `DATA_DIR/whatsapp`; conserva tanto `session.enc` como `session.key` para recuperar la sesión. No se descarga el historial de otros chats. Se ignoran mensajes repetidos y los del propio bot para evitar bucles. Las respuestas usan memoria y el modelo del Dot, sin ejecutar herramientas. Se comparte el límite de cuarenta turnos entrantes diarios con los otros canales; la actividad y los errores se ven en **Últimas comunicaciones**.

En instancias con poca CPU, cargar el servicio puede tardar más de cuatro segundos. Dots espera hasta un minuto y, si el proceso sigue arrancando, continúa comprobándolo en segundo plano: al responder, recupera la conexión guardada sin crear otro proceso ni borrar la sesión. No necesitas cambiar variables ni volver a escanear por un arranque lento. Esto comprueba que el servicio local está listo; la vinculación con WhatsApp puede tardar más o requerir otro QR si la sesión fue revocada.

Los registros muestran `Starting WhatsApp private bridge` y después `WhatsApp private bridge ready`. Si falla, la web y los registros distinguen dependencias (código 20), clave ausente o inválida (21/22), sesión cifrada ilegible (23), permisos de datos (24) y puerto ocupado o inválido (25/26). Los errores de sesión conservan los archivos existentes y detienen los reintentos: recupera la copia completa de GitHub antes de borrar o reemplazar nada. Los errores transitorios permiten hasta tres reinicios automáticos. Las salidas de las bibliotecas siguen ocultas porque pueden contener claves o mensajes; los diagnósticos usan textos fijos.

En desarrollo, `bash scripts/install.sh` instala el conector con su lockfile. Para instalarlo por separado: `cd whatsapp && npm ci`. `bash scripts/dev.sh` inicia también el servicio privado a través de la API. `WHATSAPP_QR_ENABLED=0` lo desactiva y `WHATSAPP_BRIDGE_PORT` permite cambiar su puerto local.

## Llamadas y WhatsApp con Twilio (opcional)

La integración oficial usa tu modelo de NVIDIA para responder y Twilio para telefonía, reconocimiento de voz, síntesis de voz y WhatsApp. Solo permite el número del propietario que configures. Necesita tus credenciales de Twilio y una URL pública HTTPS. Selecciona **Llamadas** o **WhatsApp → Usar Twilio** para ver estos ajustes.

## Configurar desde la web

1. Crea una cuenta en [Twilio](https://www.twilio.com/try-twilio). Verifica tu teléfono y consigue un número con capacidad de voz. El crédito de prueba es limitado; Twilio puede cobrar por números, llamadas y mensajes. La API de NVIDIA por sí sola no ofrece una línea telefónica.
2. Entra en **Llamadas y WhatsApp → Configurar**. Añade tu número en formato internacional, el número de voz de Twilio, su **Account SID**, su **Auth Token** y la URL HTTPS de esta web. El token se guarda cifrado y no se devuelve al navegador.
3. Para WhatsApp, abre el [Sandbox de Twilio](https://www.twilio.com/docs/whatsapp/sandbox). Desde tu WhatsApp, envía al número del Sandbox el código `join` que aparece en el panel. Añade ese número a la configuración de Dots. También puedes usar un remitente de WhatsApp aprobado.
4. En “When a message comes in”, configura por **POST** la URL que muestra Dots, terminada en `/api/v1/communications/webhooks/whatsapp`.
5. Elige el Dot que responderá por WhatsApp, activa la conexión y guarda. Envía un WhatsApp de texto desde tu número para empezar. Desde el chat, las herramientas `call_owner` y `whatsapp_owner` aparecen cuando el canal está configurado. Las llamadas requieren aprobación; los WhatsApp a tu número siguen la preferencia de **Envíos a mi WhatsApp**, automática por defecto. El botón de WhatsApp de la sección Llamadas y WhatsApp también respeta esa preferencia; las llamadas conservan su revisión.
6. Pulsa **Comprobar conexión**. Comprueba las credenciales contra Twilio, el remitente de voz, la verificación del destinatario si tu cuenta es Trial y la URL pública. Este botón no llama ni envía mensajes. Usa **Copiar diagnóstico** para compartir los resultados sin credenciales.

## Cuando no funciona

Rellenar los campos no verifica que Twilio acepte la cuenta ni los números. **Comprobar conexión** muestra el problema concreto. Usa el **Account SID y Auth Token reales** de tu cuenta: una cuenta Trial con crédito de prueba funciona, pero las *Test Credentials* de la API solo simulan solicitudes y nunca realizan llamadas ni entregan WhatsApp.

- **20003**: las credenciales no pertenecen a la misma cuenta o no son válidas.
- **21215**: activa el país de destino en Voice → Geo Permissions.
- **21219**: verifica tu teléfono en Verified Caller IDs para llamar desde una cuenta Trial.
- **63007**: el número de WhatsApp no es el remitente de esa cuenta.
- **63015**: envía desde tu WhatsApp el código `join` del Sandbox; la adhesión puede caducar y necesitar repetirse.
- **63016**: escribe primero desde tu WhatsApp al Sandbox para abrir la ventana de 24 horas.

La URL debe ser el origen HTTPS (por ejemplo, `https://dots-uz0g.onrender.com`). Si pegas el enlace terminado en `/app`, Dots elimina esa ruta. Guarda la URL del webhook de WhatsApp en Twilio Sandbox Settings → When a message comes in → **POST**. Tener el webhook visible en Dots no lo registra automáticamente en Twilio.

**Últimas comunicaciones** se actualiza cada cuatro segundos. Las llamadas muestran si el teléfono está sonando, ocupado, no contesta o se ha conectado. WhatsApp muestra enviado, entregado, leído o el error que impide la entrega. Estos estados llegan por callbacks firmados de Twilio; una solicitud aceptada todavía no implica entrega.

## Comportamiento y límites

- Las llamadas salientes duran como máximo tres minutos y hasta cinco turnos de respuesta. El mensaje inicial lo indica la web; después puedes hablar y tu Dot responde por voz. El callback se genera automáticamente para cada llamada, sin configurar un webhook de voz estático.
- WhatsApp responde a los mensajes de texto que lleguen desde tu número. Las respuestas de IA se procesan en segundo plano y se envían mediante Twilio. Las conversaciones se guardan en hilos separados de WhatsApp y voz, y la actividad aparece en la web.
- Los mensajes libres de WhatsApp requieren una conversación abierta en las últimas 24 horas. Este proyecto no envía plantillas fuera de esa ventana ni procesa notas de voz o archivos de WhatsApp.
- Twilio permite diez solicitudes salientes desde la web o el agente al día. El WhatsApp por QR tiene un cupo independiente de 200 solicitudes salientes; los turnos entrantes mantienen el límite compartido de cuarenta al día. Una solicitud fallida también cuenta. “Aceptado por Twilio” indica que el proveedor aceptó la solicitud; no confirma entrega o que contestaras al teléfono.
- Cada webhook valida la firma de Twilio, la cuenta y los números de origen y destino. Los mensajes se deduplican por su identificador. Las conversaciones telefónicas y de WhatsApp no ejecutan herramientas. Las llamadas y las otras acciones que necesitan revisión se aprueban desde la web; el envío automático se limita a mensajes al WhatsApp del propietario configurado.
- La aplicación necesita estar accesible cuando Twilio llama al webhook. Render Free puede suspender el servicio por inactividad y causar retrasos o fallos al despertarlo. El código no puede garantizar disponibilidad continua en ese plan.
- El procesamiento en segundo plano necesita que el proceso siga activo. Si se reinicia durante una respuesta, el evento puede quedar pendiente y se evita reenviar automáticamente para prevenir duplicados. Puedes enviar un mensaje nuevo al volver a estar disponible.

## Variables de entorno opcionales

También puedes configurar el servidor con `COMMUNICATIONS_ENABLED=1`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_PHONE_NUMBER`, `TWILIO_VOICE_NUMBER`, `TWILIO_WHATSAPP_NUMBER`, `COMMUNICATION_BOT_ID` y `COMMUNICATION_PUBLIC_URL`. La URL se deduce de `PUBLIC_APP_URL` o `RENDER_EXTERNAL_URL` si están configuradas con HTTPS, también cuando se guardó una URL vacía en la web. Si no seleccionas un Dot, se usa el primero. Los demás ajustes guardados en la web prevalecen sobre estas variables. Nunca subas las credenciales al repositorio.

Los servicios externos no se han activado ni se han realizado llamadas o envíos reales durante las pruebas del código.

En Render Free, el almacenamiento local es temporal. Las [copias cifradas en GitHub](PERSISTENCE.md) conservan ajustes, conversaciones y actividad para recuperarlos al arrancar. También puedes guardar las credenciales y números de Twilio como variables de entorno secretas en Render.
