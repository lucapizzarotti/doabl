# Doabl

Convertí tutoriales de YouTube en una checklist de pasos accionables. Mirá y accioná al mismo tiempo, sin perder el hilo.

Doabl abre un panel al costado del video de YouTube donde transformás lo que mirás en una lista de **acciones concretas**, cada una anclada al segundo exacto del video. Pensada para builders —devs y diseñadores— que aprenden haciendo.

## Cómo funciona

- **Agregás un paso** con la acción que tenés que hacer. Doabl captura el timestamp automáticamente y pausa el video mientras escribís.
- **Tocás un paso** y el video salta a ese segundo.
- **Tachás** cada paso a medida que lo hacés. Al terminar, marcás el tutorial como completado.
- Todo queda guardado **por video**, localmente en tu navegador.

## Instalación (desarrollo)

1. Cloná o descargá este repo.
2. Andá a `chrome://extensions`.
3. Activá el **Modo de desarrollador**.
4. **Cargar descomprimida** → seleccioná la carpeta del proyecto.

## Privacidad

Doabl es **100% local y gratis**. No recopila, no almacena en servidores ni transmite datos personales. Todo vive en tu navegador vía `chrome.storage.local`.

→ [Política de privacidad](https://lucapizzarotti.github.io/doabl/privacy-policy.html)

## Stack

Extensión de Chrome (Manifest V3) · Vanilla JS · Side Panel API · `chrome.storage.local`
