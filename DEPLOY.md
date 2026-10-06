# Publicar gratis desde GitHub

[Desplegar en Render](https://render.com/deploy?repo=https://github.com/mariopegna17-svg/dots)

1. Crea una cuenta de Render con GitHub y autoriza el repositorio.
2. Usa el enlace anterior. El archivo `render.yaml` propone un único servicio Docker con plan **Free**, sin disco de pago ni servicios adicionales. Revisa que el panel conserve ese plan antes de crear el servicio; los planes y requisitos de Render pueden cambiar.
3. Introduce `NVIDIA_API_KEY` únicamente en el campo secreto de Render. La clave cifrada en el entorno de Codex no se sube a GitHub ni se migra automáticamente al alojamiento.
4. Espera al despliegue. Abre la URL HTTPS que Render asigna al servicio. La raíz redirige a `/demo`, accesible sin contraseña. Ese es el enlace que puedes compartir; no se puede conocer su dirección final antes de crear el servicio.
5. Para el espacio privado entra en `/app` e introduce el valor generado de `APP_AUTH_TOKEN`, consultándolo en privado en las variables de Render. Nunca compartas ese token junto al enlace público.

## Qué ofrece el enlace público

El chat de demostración utiliza NVIDIA, sin herramientas ni acceso a conversaciones, recuerdos, ajustes, archivos o rutinas del propietario. El historial público permanece en la pestaña del visitante y se envía al proveedor para responder; no se guarda en las conversaciones privadas. Hay 20 consultas diarias en total, compartidas entre visitantes, y un máximo de dos respuestas simultáneas. El presupuesto se cuenta en SQLite antes de llamar al proveedor; una petición fallida también consume una consulta. El proveedor puede facturar o descontar cuota por esas consultas aunque el alojamiento sea gratuito.

La sección privada conserva los agentes, memoria y rutinas, protegidos por el token. Esta versión sigue siendo de un único propietario; no ofrece cuentas independientes para visitantes.

## Límites de la opción gratuita

Las instancias gratuitas pueden suspenderse y tardar en arrancar al recibir una visita. Mientras estén suspendidas las rutinas no se ejecutan. Los datos locales no tienen persistencia garantizada: al reiniciar o redesplegar pueden perderse memoria, rutinas, conversaciones y el contador de cuota. No uses este plan para rutinas importantes ni como un límite de gasto infalible.

El ordenador Docker de los agentes necesita un servidor compatible. Este despliegue utiliza el adaptador remoto y no configura un servicio de ordenador: si se intenta iniciarlo mostrará un error explícito. El chat público no ofrece esa herramienta. Para toda la funcionalidad usa un VPS con Docker o configura un servicio compatible con `COMPUTER_REMOTE_BASE_URL` y su credencial.

La publicación requiere una cuenta de alojamiento y acceso al repositorio. Tener código en GitHub o un archivo de despliegue no significa que ya exista una web publicada.
