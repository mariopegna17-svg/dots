# Llamadas y WhatsApp

La integración usa tu modelo de NVIDIA para responder y Twilio para telefonía, reconocimiento de voz, síntesis de voz y WhatsApp. Solo permite el número del propietario que configures. No viene activada: necesita tus credenciales de Twilio y una URL pública HTTPS.

## Configurar desde la web

1. Crea una cuenta en [Twilio](https://www.twilio.com/try-twilio). Verifica tu teléfono y consigue un número con capacidad de voz. El crédito de prueba es limitado; Twilio puede cobrar por números, llamadas y mensajes. La API de NVIDIA por sí sola no ofrece una línea telefónica.
2. Entra en **Llamadas y WhatsApp → Configurar**. Añade tu número en formato internacional, el número de voz de Twilio, su **Account SID**, su **Auth Token** y la URL HTTPS de esta web. El token se guarda cifrado y no se devuelve al navegador.
3. Para WhatsApp, abre el [Sandbox de Twilio](https://www.twilio.com/docs/whatsapp/sandbox). Desde tu WhatsApp, envía al número del Sandbox el código `join` que aparece en el panel. Añade ese número a la configuración de Dots. También puedes usar un remitente de WhatsApp aprobado.
4. En “When a message comes in”, configura por **POST** la URL que muestra Dots, terminada en `/api/v1/communications/webhooks/whatsapp`.
5. Elige el Dot que responderá por WhatsApp, activa la conexión y guarda. Envía un WhatsApp de texto desde tu número para empezar. En la web puedes revisar y confirmar una llamada o un mensaje; desde el chat, las herramientas `call_owner` y `whatsapp_owner` aparecen cuando el canal está configurado y requieren aprobación.

## Comportamiento y límites

- Las llamadas salientes duran como máximo tres minutos y hasta cinco turnos de respuesta. El mensaje inicial lo indica la web; después puedes hablar y tu Dot responde por voz. El callback se genera automáticamente para cada llamada, sin configurar un webhook de voz estático.
- WhatsApp responde a los mensajes de texto que lleguen desde tu número. Las respuestas de IA se procesan en segundo plano y se envían mediante Twilio. Las conversaciones se guardan en hilos separados de WhatsApp y voz, y la actividad aparece en la web.
- Los mensajes libres de WhatsApp requieren una conversación abierta en las últimas 24 horas. Este proyecto no envía plantillas fuera de esa ventana ni procesa notas de voz o archivos de WhatsApp.
- Hay un máximo de diez solicitudes salientes desde la web o el agente y cuarenta turnos entrantes al día, compartidos por canal. Una solicitud fallida también cuenta. “Aceptado por Twilio” indica que el proveedor aceptó la solicitud; no confirma entrega o que contestaras al teléfono.
- Cada webhook valida la firma de Twilio, la cuenta y los números de origen y destino. Los mensajes se deduplican por su identificador. Las conversaciones telefónicas y de WhatsApp no ejecutan herramientas; las acciones se aprueban desde la web.
- La aplicación necesita estar accesible cuando Twilio llama al webhook. Render Free puede suspender el servicio por inactividad y causar retrasos o fallos al despertarlo. El código no puede garantizar disponibilidad continua en ese plan.
- El procesamiento en segundo plano necesita que el proceso siga activo. Si se reinicia durante una respuesta, el evento puede quedar pendiente y se evita reenviar automáticamente para prevenir duplicados. Puedes enviar un mensaje nuevo al volver a estar disponible.

## Variables de entorno opcionales

También puedes configurar el servidor con `COMMUNICATIONS_ENABLED=1`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `OWNER_PHONE_NUMBER`, `TWILIO_VOICE_NUMBER`, `TWILIO_WHATSAPP_NUMBER`, `COMMUNICATION_BOT_ID` y `COMMUNICATION_PUBLIC_URL`. La URL se deduce de `PUBLIC_APP_URL` o `RENDER_EXTERNAL_URL` si están configuradas con HTTPS. Los ajustes guardados en la web prevalecen sobre estas variables. Nunca subas las credenciales al repositorio.

Los servicios externos no se han activado ni se han realizado llamadas o envíos reales durante las pruebas del código.

En Render Free, el almacenamiento local es temporal y puede perder los ajustes al desplegar o reiniciar. Para conservar la conexión, guarda las credenciales y números como variables de entorno secretas en Render. Las conversaciones y la actividad necesitan almacenamiento persistente para sobrevivir a esos reinicios.
