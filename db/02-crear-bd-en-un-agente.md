# 02 · Crear una BD con un pod en un agente específico, y comprobarla

Requisito: haber completado `01-instalacion-y-preparacion.md`.

Los nombres (`mi-db`, `k3s-agent1`) son los del ensayo: adáptalos.

---

## 1. Dónde nacerá la BD: etiquetar SOLO el agente de origen

La BD usa `nodeSelector: db: postgres`. Para que nazca en un agente concreto, **solo ese agente debe tener el label** en este momento. El agente de destino se etiqueta más tarde (en `03-traslado-parte-1-replica.md`).

```bash
kubectl label node k3s-agent1 db=postgres
kubectl get nodes -L db
```

**Esperado:** columna `DB` con `postgres` únicamente en `k3s-agent1`.

- Quitar un label: `kubectl label node k3s-agent1 db-` (con el guion final). No afecta a pods que ya corren; solo influye en dónde se programan los nuevos.
- Ese filtro afecta solo a la BD de CNPG, no al resto de tus cargas.

## 2. El manifiesto

```bash
cat > mi-db.yaml <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: mi-db
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:16.8
  storage:
    size: 5Gi
    storageClass: local-path
  affinity:
    enablePodAntiAffinity: true
    podAntiAffinityType: required
    topologyKey: kubernetes.io/hostname
    nodeSelector:
      db: postgres
EOF
```

- `podAntiAffinityType: required` (por defecto es `preferred`): garantiza que la futura réplica **siempre** caiga en otro nodo. Si no puede, queda en `Pending`.
- **No cambies `affinity` ni `nodeSelector` durante el traslado:** modificar la plantilla del pod puede disparar un rolling update con su propio switchover. Deja esta configuración fija desde el inicio.
- Imagen `16.8` y `5Gi` son para ensayo. Usa la misma versión mayor de Postgres que necesites.

## 3. Crear y verificar

```bash
kubectl apply -f mi-db.yaml
# esperar 1 o 2 minutos (descarga de imagen)
kubectl get pods -o wide
kubectl get pvc
kubectl cnpg status mi-db
```

**Esperado:**

- Primero un pod `mi-db-1-initdb-...` que termina en `Completed`, y luego `mi-db-1` en `1/1 Running` en **`k3s-agent1`**.
- PVC `mi-db-1` en `Bound`.
- `status`: `Cluster in healthy state`, `Instances: 1`, `Primary instance: mi-db-1`, y `Streaming Replication status: Not configured` (normal con una sola instancia).

Si tras 4 o 5 minutos el pod sigue en `Pending` o `Init`: `kubectl describe pod mi-db-1`.

Con `local-path`, esa instancia queda atada a ese nodo. Los traslados se hacen con réplica + switchover, no moviendo el pod.

## 4. Probar la conexión (sin túnel)

Dentro del pod, `psql` por el socket local usa autenticación *peer*, así que entra como **`postgres`**, no como `app` (con `-U app` da `Peer authentication failed`).

```bash
kubectl cnpg psql mi-db -- -P pager=off -U postgres app \
  -c "select version();" \
  -c "create table if not exists prueba (id serial primary key, nota text);" \
  -c "insert into prueba (nota) values ('uno'), ('dos'), ('tres');" \
  -c "select * from prueba;"
```

**Esperado:** versión 16.8, `CREATE TABLE`, `INSERT 0 3` y 3 filas. Estas filas son la referencia para comprobar el traslado.

(`-P pager=off` evita el paginador; si aparece `(END)`, sal con `q`. No uses `Ctrl+C` a mitad: repetir el `insert` duplicaría filas.)

## 5. Probar el acceso como aplicación (usuario `app` por el Service)

El operador crea el usuario `app`, la base `app` y el secreto `mi-db-app`. Las aplicaciones deben conectarse al Service `mi-db-rw` (siempre apunta al primario), nunca a un pod concreto. Este pod temporal lo simula:

```bash
kubectl run psql-test --rm -it --restart=Never \
  --image=ghcr.io/cloudnative-pg/postgresql:16.8 \
  --env="PGPASSWORD=$(kubectl get secret mi-db-app -o jsonpath='{.data.password}' | base64 -d)" \
  -- psql -h mi-db-rw -U app -d app -P pager=off \
  -c "select current_user, pg_is_in_recovery() as es_replica, inet_server_addr() as ip_del_pod;"
```

**Esperado:** `current_user = app`, `es_replica = f` e `ip_del_pod` = la IP de `mi-db-1` (en el ensayo `10.42.1.14`). **Anota esa IP**: tras el traslado debe cambiar.

La contraseña queda visible en la definición del pod mientras exista (segundos). Vale para pruebas, no para datos reales.

Las filas de `prueba` se crearon como `postgres`; el usuario `app` podría no tener permiso para leerlas (no se comprobó).

## 6. Conexión desde tu PC con `port-forward` (problema conocido)

```bash
kubectl port-forward svc/mi-db-rw 5432:5432
```

En el ensayo el túnel **muere al cerrarse la primera conexión con TLS** (`connection reset by peer` → `lost connection to pod`), con `psql` y con sqlit, y tanto hacia el Service como hacia el pod.

- **Comprobado:** el fallo ocurre siempre con TLS y nunca con `PGSSLMODE=disable` (5 de 5 conexiones, túnel vivo). Postgres no registra ningún error.
- **Inferido, no verificado:** el mecanismo (reset TCP al cerrar la sesión TLS) y que sea una interacción conocida entre containerd y `port-forward`.
- **Workaround:** `PGSSLMODE=disable psql -h 127.0.0.1 -p 5432 -U app -d app` (en sqlit, TLS Mode = `disable`). El tráfico hasta el cluster va cifrado por el túnel de la API; solo el último salto dentro del pod va sin TLS.
- Alternativa no probada: túnel SSH al server hacia la ClusterIP del Service (`ssh -N -L 127.0.0.1:5432:<IP_de_mi-db-rw>:5432 usuario@IP_DEL_SERVER`).
- Tras un switchover hay que reabrir el túnel, porque se ata a un pod al arrancar.

Nada de esto es necesario para el método: `kubectl cnpg psql` y los pods dentro del cluster no usan `port-forward`.

---

## Comprobación final de esta sección

- [ ] `mi-db-1` `Running` en el agente de origen, `RESTARTS 0`.
- [ ] `Cluster in healthy state`.
- [ ] Tabla `prueba` con 3 filas.
- [ ] IP del primario vista desde el Service anotada.

**Siguiente:** `03-traslado-parte-1-replica.md`.
