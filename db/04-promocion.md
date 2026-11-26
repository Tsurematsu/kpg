# 04 · Proceso de promoción (switchover)

Requisito: `03-traslado-parte-1-replica.md` completado, con `mi-db-2` en `streaming` y sin retraso.

Los nombres son los del ensayo: adáptalos.

---

## Qué ocurre

Una réplica en streaming es un Postgres en modo recuperación. **Promover** es sacarla de ese modo: termina de aplicar el WAL recibido, abre una **nueva timeline** y acepta escrituras. No se copian datos.

En el switchover de CNPG:

1. El primario actual se apaga de forma ordenada (intenta archivar el WAL pendiente).
2. La réplica elegida se promueve (un Lease de Kubernetes garantiza un solo primario).
3. El primario viejo se reinicia como réplica (por eso su `RESTARTS` sube en 1).
4. El Service `mi-db-rw` pasa a apuntar al nuevo primario.

**No es destructivo:** el primario viejo conserva sus datos y sigue en su nodo como réplica.

**Corte en el ensayo:** entre la orden (22:11:23 UTC) y la promoción (22:11:30 UTC) pasaron unos 7 segundos. Sale de las marcas de tiempo del operador, **no** de una medición desde un cliente: el corte real que vería una aplicación no se midió.

## Antes de promover

- [ ] `mi-db-2` en `streaming`, lags en cero (ver archivo 03).
- [ ] Con tráfico real, confirmar que no hay lag justo antes (la replicación es asíncrona).
- [ ] No estás cambiando `affinity`/`nodeSelector` en este momento.

## 1. Estado de partida

```bash
kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'; echo
kubectl cnpg status mi-db
```

**Esperado:** `mi-db-1` como primario; `mi-db-2` como `Standby (async)` en `streaming`.

## 2. Promover

```bash
kubectl cnpg promote mi-db mi-db-2
```

Sintaxis: `kubectl cnpg promote <BD> <instancia>`. **Esperado:** un log `Cluster has become unhealthy` (transitorio) y `Node mi-db-2 in cluster mi-db will be promoted`.

## 3. Esperar y verificar

Espera 20 o 30 segundos y repite hasta que se estabilice:

```bash
kubectl cnpg status mi-db
kubectl get pods -o wide
kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'; echo
```

**Durante la transición (normal):** `Status: Switchover in progress`, `Ready instances: 1`, `mi-db-1` con `InternalError` y un error de `no such file or directory` en el socket, y su pod en `0/1` con `RESTARTS 1`. Es `mi-db-1` reiniciándose como réplica y se resuelve solo en segundos.

**Esperado al final:**

- `Status: Cluster in healthy state`, `Instances: 2`, `Ready instances: 2`.
- `Primary instance: mi-db-2` (en el agente destino), timeline avanzada de 1 a 2.
- `mi-db-1` como `Standby (async)` en el agente origen, en `streaming`, lags en cero y LSN iguales.
- Ambos pods `1/1 Running`.
- `currentPrimary` = `mi-db-2`.

Si pasados 2 minutos `mi-db-1` no vuelve a `Ready`: `kubectl describe pod mi-db-1`.

## 4. Verificar datos y escritura en el nuevo primario

```bash
kubectl cnpg psql mi-db -- -P pager=off -U postgres app \
  -c "select pg_is_in_recovery() as es_replica;" \
  -c "select * from prueba;" \
  -c "insert into prueba (nota) values ('cuatro');" \
  -c "select * from prueba;"
```

**Esperado:** `es_replica = f`, las 3 filas originales, `INSERT 0 1` y 4 filas.

## 5. Verificar el Service (lo que ve una aplicación)

```bash
kubectl run psql-test --rm -it --restart=Never \
  --image=ghcr.io/cloudnative-pg/postgresql:16.8 \
  --env="PGPASSWORD=$(kubectl get secret mi-db-app -o jsonpath='{.data.password}' | base64 -d)" \
  -- psql -h mi-db-rw -U app -d app -P pager=off \
  -c "select current_user, pg_is_in_recovery() as es_replica, inet_server_addr() as ip_del_pod;"
```

**Esperado:** `current_user = app`, `es_replica = f` y `ip_del_pod` = la IP de `mi-db-2` (en el ensayo cambió de `10.42.1.14` a `10.42.2.11`). La aplicación no cambió nada: solo cambió el pod detrás del Service.

## Notas

- Si usas `kubectl port-forward`, **ábrelo de nuevo**: quedó atado al pod anterior.
- Dónde probar primero: este paso debe ensayarse con datos de prueba antes de hacerlo en producción.
- Un solo server k3s es punto único de falla del plano de control: sin él, el operador no puede hacer switchover ni failover.

## Comprobación final de esta sección

- [ ] `currentPrimary` = `mi-db-2`.
- [ ] 4 filas en `prueba`.
- [ ] `mi-db-rw` llega a la IP del pod nuevo.
- [ ] `mi-db-1` sana como réplica.

**No reduzcas `instances` ni borres nada hasta confirmar todo lo anterior.**

**Siguiente:** `05-limpieza-completa.md`.
