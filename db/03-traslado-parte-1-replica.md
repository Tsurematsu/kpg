# 03 · Traslado, parte 1: crear la réplica en el agente destino (antes de la promoción)

Requisito: `02-crear-bd-en-un-agente.md` completado (BD `mi-db` con 1 instancia en `k3s-agent1`).

Objetivo: tener una réplica en `k3s-agent2` **sincronizada y sin retraso**. Aquí no se promueve nada ni se borra nada.

Los nombres son los del ensayo: adáptalos.

---

## Antes de empezar

- **Espacio:** el agente destino necesita espacio para una copia completa de la BD.
- **Carga:** la copia inicial (`pg_basebackup`) lee todo el volumen del primario; hazla en horario de baja carga. Con 62 MB del ensayo fue instantánea.
- **Misma versión mayor de Postgres** entre origen y destino (aquí es la misma BD, así que se cumple).
- **No toques `affinity` ni `nodeSelector`** durante el traslado.
- **Ensaya antes con datos de prueba**, no directamente en producción.
- **Respaldo:** en el ensayo se omitió porque eran datos de prueba. Con datos reales, haz un respaldo (`pg_dumpall` o backup de CNPG) antes de seguir.

## 1. Etiquetar el agente destino

El agente destino necesita `db=postgres`, o la réplica quedará en `Pending`.

```bash
kubectl label node k3s-agent2 db=postgres
kubectl get nodes -L db
```

**Esperado:** `postgres` en ambos agentes y vacío en `k3s-server`.

## 2. Estado de partida (solo lectura)

```bash
kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'; echo
kubectl cnpg status mi-db
```

**Esperado:** primario `mi-db-1`, `Instances: 1`, `Cluster in healthy state`.

## 3. Subir a 2 instancias

Cambia solo `instances` en el manifiesto y comprueba que es el único cambio:

```bash
sed -i 's/instances: 1/instances: 2/' mi-db.yaml
grep -n "instances" mi-db.yaml
kubectl apply -f mi-db.yaml
```

**Esperado:** `grep` muestra una sola línea con `instances: 2`, y `cluster.postgresql.cnpg.io/mi-db configured`.

Como `podAntiAffinityType` es `required` y el agente de origen ya tiene una instancia, la nueva solo puede caer en el destino.

## 4. Esperar y verificar

Repite hasta que `mi-db-2` esté `Running` (1 o 2 minutos):

```bash
kubectl get pods -o wide
kubectl get pvc
kubectl cnpg status mi-db
```

**Esperado:**

- Primero un pod `mi-db-2-join-...` (la copia inicial) que termina, y luego `mi-db-2` en `1/1 Running` en **`k3s-agent2`**.
- **`mi-db-1` sigue `Running` en agent1 con `RESTARTS 0`:** cambiar solo `instances` no lo reinicia.
- PVC `mi-db-2` en `Bound` (con `local-path`, vive físicamente en agent2).
- En `status`: `Instances: 2`, `Ready instances: 2`, `Cluster in healthy state`, y en **Streaming Replication status** una fila de `mi-db-2` con `State = streaming`, `Write/Flush/Replay Lag` en `00:00:00` (o casi) y los LSN iguales entre ambas instancias.

Si `mi-db-2` queda en `Pending` más de 3 o 4 minutos: `kubectl describe pod mi-db-2` (lo más probable: falta el label en el destino).

## 5. Qué mirar antes de seguir

- [ ] `mi-db-2` en `streaming`.
- [ ] Lags en `00:00:00` y LSN iguales.
- [ ] `mi-db-1` sin reinicios.

La replicación es **asíncrona** por defecto (`Sync State: async`). Si en el momento de promover hay lag, pueden perderse las últimas transacciones. En el ensayo no se escribía nada, así que el lag era cero; con tráfico real, confírmalo justo antes de promover. Para cero pérdida hay que configurar replicación síncrona (no probado aquí).

**No pases al siguiente archivo hasta que la réplica esté en `streaming` y sin retraso.**

**Siguiente:** `04-promocion.md`.
