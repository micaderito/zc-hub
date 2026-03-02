# Tienda Nube: permisos y webhooks

## Error 403 "Missing a required scope" al registrar webhooks

Para que esta app pueda **registrar webhooks de órdenes** (order/paid, order/cancelled, etc.), la aplicación en Tienda Nube debe tener el permiso de **Órdenes**.

### Pasos

1. Entrá a **[Partners Tienda Nube](https://partners.tiendanube.com)** (o [partners.nuvemshop.com.br](https://partners.nuvemshop.com.br)).
2. **Aplicaciones** → elegí tu app → **Editar datos** (o "Edit data").
3. En **Permisos** (o "Basic Data" / permisos), activá **Órdenes** (lectura y/o escritura: `read_orders` / `write_orders`).  
   Según la documentación de TN, los webhooks solo se pueden registrar para recursos sobre los que tenés permiso.
4. **Guardá** los cambios.
5. En esta app (Zonacuaderno): **desconectá Tienda Nube** y **volvé a conectar**. Así se obtiene un nuevo token con el scope de órdenes.
6. Opcional: en la página **Sincronización**, usá de nuevo el botón **Registrar webhooks Tienda Nube**.

Después de eso, el registro de webhooks debería funcionar.
