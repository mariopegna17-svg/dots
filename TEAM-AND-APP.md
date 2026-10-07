# Equipo, temas y app para iPhone

## Trabajar en equipo

1. Abre **Equipo de Dots** en la barra lateral.
2. Selecciona entre dos y cuatro Dots y elige un coordinador.
3. Escribe la tarea y pulsa **Trabajar juntos**.
4. Cada Dot aporta una solución desde sus reglas y especialidad. Después recibe las aportaciones de los demás y las revisa. El coordinador sintetiza los análisis y las revisiones en una única respuesta final.

Puedes abrir cada aportación y revisión, copiar el resultado y consultar los trabajos anteriores. La tarea continúa al cambiar de sección o cerrar la pestaña mientras el servidor siga funcionando. **Cancelar tarea** detiene las consultas del equipo. Un reinicio señala la interrupción y no vuelve a ejecutar silenciosamente la misma tarea.

Cada participante utiliza su modelo configurado y sus propias notas. El equipo comparte solo las aportaciones de esta tarea; no importa conversaciones privadas de otros Dots. Las reglas del agente se mantienen. Las consultas de IA usan tu proveedor y su cuota. Hay un máximo de dos consultas de miembros a la vez, tres trabajos activos/en espera y treinta trabajos en el historial.

Los equipos pueden razonar y buscar información. No ejecutan escrituras, llamadas, mensajes ni publicaciones de YouTube. Si alguna aportación falla, la interfaz muestra el fallo y marca el resultado como parcial; no inventa un trabajo completado.

## Personalizar

En **Ajustes → Apariencia** puedes elegir:

- Temas **Cristal**, **Luz**, **Aurora** o **Medianoche**.
- Acentos azul, menta, violeta o rosa.
- Espaciado cómodo o compacto.
- Animaciones y reflejos activados o reducidos.

Los cambios se previsualizan de inmediato. Pulsa **Guardar apariencia** para conservarlos en el servidor y en este navegador. Al cerrar sin guardar se recupera la apariencia anterior. También se respeta «Reducir movimiento» del dispositivo.

## Añadir Dots al iPhone

1. Actualiza tu despliegue de Render con **Manual Deploy → Deploy latest commit**.
2. Abre `https://dots-uz0g.onrender.com/app` en **Safari**.
3. Pulsa **Compartir → Añadir a pantalla de inicio**. En versiones que lo muestran, activa **Abrir como app**.
4. Pulsa **Añadir**. Aparecerá el icono Liquid Glass; abre Dots desde ese icono.
5. Si pide acceso de nuevo, introduce tu clave de propietario. La sesión instalada puede ser independiente de Safari.

La aplicación tiene manifiesto, icono PNG transparente y configuración de Apple para abrirse sin la barra del navegador. En Android y navegadores compatibles aparece también la opción de instalar. El sistema operativo decide la máscara y el fondo final del icono.

La aplicación necesita internet para conversar y ejecutar tareas. Al estar sin conexión muestra una página para reconectar. El service worker almacena únicamente el icono público y esa página; no almacena sesiones, conversaciones ni respuestas de la API. Se registra solo en producción bajo un origen seguro. Las áreas seguras del iPhone se respetan al abrir en modo app.

Instalar el icono no mantiene despierto un servidor de Render Free. El servicio sigue sujeto a sus límites de suspensión y almacenamiento.
