# Conversación de voz manos libres

1. Abre el chat de un Dot y pulsa **Voz**, el botón con auriculares junto al cuadro de escritura. El icono de micrófono del cuadro sirve para dictar texto.
2. Oirás «Hola, soy tu Dot. Ya puedes hablar conmigo». Ese saludo activa el altavoz con tu pulsación, también en Safari. Permite el micrófono cuando el navegador lo solicite.
3. Habla y haz una pausa. El texto reconocido se envía una sola vez; el Dot lee las frases completas conforme llegan, sin esperar al final de toda la respuesta, y vuelve a escuchar.
4. **Pausar** detiene el micrófono y el altavoz hasta que pulses **Retomar voz**. **Interrumpir y hablar** para la lectura; si el servidor todavía trabaja, **Parar lectura** conserva la petición en curso y espera a que termine. **Volver a escribir** o la cruz cierran la voz.
5. Abre **Voz y ritmo** para elegir una voz española instalada, la velocidad y cuánto dura la pausa antes de enviar. Estos ajustes se guardan en este dispositivo. Los subtítulos muestran tu frase y el fragmento que lee el Dot.

El micrófono se pausa mientras se prepara o reproduce una respuesta para evitar captar la voz del Dot. **Enviar ahora** permite confirmar la frase visible. Los mensajes antiguos del historial no se leen automáticamente. Cerrar el modo no cancela un envío que el servidor ya ha empezado; comprueba WhatsApp antes de repetir un envío cuyo resultado sea incierto.

Si no oyes el saludo, sube el volumen **multimedia**, revisa si el sonido sale por auriculares Bluetooth y pulsa **Probar altavoz**. **Repetir respuesta** vuelve a leer la última respuesta sin consultar otra vez al modelo ni ejecutar de nuevo sus acciones. Si la reproducción falla, **Reintentar voz** conserva y reproduce la respuesta pendiente. La interfaz solo indica «Dot está hablando» cuando el navegador confirma el inicio del audio; si no arranca, muestra cómo recuperarlo.

Los WhatsApp pedidos a tu número vinculado se envían automáticamente con la preferencia predeterminada. En Ajustes → **Envíos a mi WhatsApp** puedes desactivar **Enviar sin pedirme confirmación**. En revisión manual, y para las otras acciones que lo requieran, la voz se pausa y **Revisar en el chat** muestra la tarjeta real; hablar no pulsa sus botones.

La voz usa `SpeechRecognition` o `webkitSpeechRecognition` y `speechSynthesis`. No necesita otra clave de IA ni Twilio. El reconocimiento puede usar el servicio de voz del navegador. Fuera de localhost necesitas HTTPS, como en Render. En iPhone depende del soporte y los permisos de Safari; si la aplicación añadida a la pantalla de inicio no ofrece reconocimiento, ábrela en Safari. El chat informa cuando faltan estas funciones y permite seguir escribiendo.

Mantén la pantalla de conversación abierta. Si el navegador admite bloqueo de suspensión, Dots solicita mantenerla despierta durante la conversación y libera ese bloqueo al pausar o cerrar. Al cambiar de pestaña se pausa; al volver o recuperar Internet retoma la respuesta pendiente automáticamente. Una pausa manual permanece pausada.

Los cortes del reconocimiento permiten tres reintentos con espera creciente; el altavoz permite dos reintentos del fragmento pendiente y recupera una pausa interna del navegador. Estas recuperaciones nunca repiten la petición al modelo ni sus acciones. Si se agotan, falta permiso o el navegador bloquea el sonido, aparece **Reintentar voz**. Una respuesta real que llegue después del tiempo de espera puede leerse sin reenviar la solicitud. La web no garantiza conversación en segundo plano ni con el teléfono bloqueado; el alojamiento y los servicios de voz también deben estar disponibles.

**Rápida** es el modo predeterminado del chat y **Razonamiento** se puede elegir en Ajustes. El modo voz pide respuestas naturales de una a cuatro frases y usa una generación breve; la conexión, el arranque del alojamiento y el proveedor siguen influyendo en la espera.

Pruebas del controlador, sin micrófono real ni envío externo:

```bash
cd client
node --test tests/*.test.mjs
```
