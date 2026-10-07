# Guardar y recuperar los datos desde GitHub

La aplicación puede guardar una copia **cifrada** en la rama `dots-data` de tu repositorio. Al arrancar con un disco vacío, la recupera antes de abrir SQLite, los conectores o WhatsApp. La rama de código `main` permanece independiente de estas copias.

## Activar en Render una vez

1. En GitHub abre **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**: [crear token](https://github.com/settings/personal-access-tokens/new).
2. Elige únicamente el repositorio **mariopegna17-svg/dots**. En permisos del repositorio selecciona **Contents → Read and write**. Pon una caducidad que puedas renovar y genera el token.
3. En tu servicio de Render abre **Environment**. Añade:

   | Variable | Valor |
   | --- | --- |
   | `GITHUB_BACKUP_REPOSITORY` | `mariopegna17-svg/dots` |
   | `GITHUB_BACKUP_TOKEN` | El token que acabas de generar, como secreto |

4. Conserva el **mismo `APP_AUTH_TOKEN`** ya configurado en Render, de al menos 32 caracteres. La copia utiliza una clave de cifrado derivada de ese secreto. No lo pegues en GitHub, en un commit ni en el chat. Si quieres separar recuperación y acceso, configura un `DATA_BACKUP_KEY` aleatorio de al menos 32 caracteres y consérvalo en Render desde la primera copia.
5. Guarda las variables y despliega el último commit de `main`. En **Ajustes → Conservar mis datos** verifica que figure el repositorio y la fecha de una copia confirmada. **Guardar ahora en GitHub** fuerza una comprobación sin esperar.

Las variables pertenecen al entorno de Render y sobreviven a reinicios y despliegues. El token de GitHub permite guardar; la clave estable permite descifrar. No se incluyen las variables de arranque en el repositorio. Si cambias o pierdes la clave de recuperación, la copia anterior no podrá descifrarse. Cambiar solo el token de GitHub no cambia el cifrado.

## Qué conserva

- Claves de NVIDIA, Composio y telefonía, junto con la clave local de cifrado.
- Dots, reglas, modelos, conversaciones, recuerdos, rutinas, ajustes y temas.
- Composición del equipo, coordinador y trabajos/contribuciones guardados.
- Identidad de la instalación en Composio: se conserva para recuperar las cuentas vinculadas.
- Credenciales y claves Signal de WhatsApp, su configuración y los registros de mensajes procesados. WhatsApp vuelve a conectar al arrancar si sigue autorizada la sesión; una revocación de WhatsApp requiere vincularla otra vez.
- Archivos del espacio de trabajo de hasta 1 MB cada uno.

La copia usa una instantánea consistente de SQLite, no una copia a medias del archivo mientras se escribe. Todos sus archivos se comprimen y cifran con autenticación antes de salir del servidor. Incluso en un repositorio público, `dots-state.enc` no expone las claves, los recuerdos ni la sesión de WhatsApp. Los archivos restaurados se escriben con permisos privados.

Se comprueban cambios cada 30 segundos y se guarda al cerrar normalmente el servidor, después de que los trabajadores y WhatsApp terminen. Si no han cambiado los datos, no se crea otro commit. Un cierre forzado o un fallo de GitHub puede perder los cambios posteriores a la última copia confirmada; revisa el estado y usa **Guardar ahora** después de configurar cuentas importantes. GitHub es un almacén de copias, con sus cuotas y límites, y no una base de datos en tiempo real.

## Recuperación y límites

Con las variables anteriores, un disco vacío se restaura automáticamente. Si la clave no coincide, GitHub rechaza el acceso, la copia está dañada o los datos locales y remotos entran en conflicto, la aplicación evita sustituir la copia válida por datos vacíos. Revisa las variables y los registros de arranque. Usa una sola instancia de la API.

Si el disco local sigue existiendo y corresponde a la última copia, se conservan también los cambios locales todavía no enviados. Las tareas que estaban en ejecución se marcan interrumpidas y no se repiten a ciegas. Las rutinas futuras y las pausadas permanecen programadas; necesitan que el servidor esté encendido para ejecutarse. Las aprobaciones pendientes no se convierten en permisos tras un reinicio. La sesión web puede pedir acceso de propietario nuevamente.

El máximo es 20 MB cifrados, 64 MB descomprimidos y 1000 archivos. Los vídeos temporales de YouTube, registros, dependencias y archivos de los ordenadores aislados no se incluyen. Al eliminar información, también se actualiza la copia; GitHub puede conservar versiones cifradas anteriores en el historial de la rama.

**Descargar copia cifrada** crea una copia local privada desde los datos actuales, también cuando el guardado remoto todavía no está activo. Guárdala junto con tu clave de recuperación en un lugar seguro. No la subas a `main`: la aplicación solo lee la copia de `dots-data`.

Esta función conserva los datos a partir de la primera copia confirmada. No puede recuperar lo que Render ya haya borrado. Activarla requiere actualizar el servicio; los datos de una versión anterior sin copia pueden perderse durante ese primer despliegue en Render Free.
