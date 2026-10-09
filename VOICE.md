# Conversación de voz manos libres

1. Abre el chat de un Dot y pulsa **Voz** junto al cuadro de escritura.
2. Permite el micrófono cuando el navegador lo solicite.
3. Habla y haz una pausa. El texto reconocido se envía una sola vez; el Dot prepara una respuesta breve, la lee y vuelve a escuchar.
4. Usa **Interrumpir y hablar** para detener la lectura y hacer otra pregunta. **Volver a escribir** o la cruz cierran el micrófono y la voz.

El micrófono se pausa mientras se prepara o reproduce una respuesta para evitar captar la voz del Dot. **Enviar ahora** permite confirmar la frase visible. Los mensajes antiguos del historial no se leen automáticamente. Cerrar el modo no cancela un envío que el servidor ya ha empezado; comprueba WhatsApp antes de repetir un envío cuyo resultado sea incierto.

Los WhatsApp pedidos a tu número vinculado se envían automáticamente con la preferencia predeterminada. En Ajustes → **Envíos a mi WhatsApp** puedes desactivar **Enviar sin pedirme confirmación**. En revisión manual, y para las otras acciones que lo requieran, la voz se pausa y **Revisar en el chat** muestra la tarjeta real; hablar no pulsa sus botones.

La voz usa `SpeechRecognition` o `webkitSpeechRecognition` y `speechSynthesis`. No necesita otra clave de IA ni Twilio. El reconocimiento puede usar el servicio de voz del navegador. Fuera de localhost necesitas HTTPS, como en Render. En iPhone depende del soporte y los permisos de Safari; si la aplicación añadida a la pantalla de inicio no ofrece reconocimiento, ábrela en Safari. El chat informa cuando faltan estas funciones y permite seguir escribiendo.

Mantén la pantalla de conversación abierta. Al salir de la página se pausa el micrófono y la lectura; pulsa **Retomar voz** para continuar. Los errores de red o permisos necesitan un nuevo gesto en **Reintentar voz** y no repiten mensajes automáticamente. La web no garantiza conversación en segundo plano ni con el teléfono bloqueado.

**Rápida** es el modo predeterminado del chat y **Razonamiento** se puede elegir en Ajustes. El modo voz pide respuestas naturales de una a cuatro frases y usa una generación breve; la conexión, el arranque del alojamiento y el proveedor siguen influyendo en la espera.

Pruebas del controlador, sin micrófono real ni envío externo:

```bash
cd client
node --test tests/handsFreeVoice.test.mjs
```
