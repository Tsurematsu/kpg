# 05 · Limpieza completa

Requisito: `04-promocion.md` completado y verificado (primario nuevo, datos íntegros).

Tiene dos partes:

- **Parte A:** cerrar el traslado (eliminar la instancia vieja y su volumen, quitar el label del origen). Es lo que se ejecutó en el ensayo.
- **Parte B (opcional):** desmontar por completo el ensayo (BD, labels, operador, plugin). **Los comandos de la parte B no se ejecutaron en el ensayo.**

Los nombres son los del ensayo: adáptalos.

---

# PARTE A · Cerrar el traslado

## Avisos (únicos pasos destructivos de todo el método)

- Con `local-path` (`RECLAIMPOLICY Delete`), **borrar un PVC elimina de forma permanente los datos** de ese volumen.
- **Orden crítico:** reduce o elimina instancias solo **después** de promover y de confirmar que el primario es la instancia nueva:
  `kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'` → debe decir `mi-db-2`. Si se hace antes, podría eliminarse la réplica recién creada.
- **Respaldo:** en el ensayo se omitió (datos de prueba). Con datos reales, verifica que existe uno antes de seguir.
- Detente y revisa si algo sale distinto a lo esperado.

## A1. Comprobación previa (solo lectura)

```bash
kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'; echo
kubectl cnpg status mi-db
kubectl cnpg psql mi-db -- -P pager=off -U postgres app -c "select * from prueba;"
kubectl cnpg destroy --help
kubectl get pvc
```

**Esperado:** primario `mi-db-2`, `mi-db-1` como `Standby` en `streaming`, 4 filas, dos PVC en `Bound`.

## A2. Eliminar la instancia vieja conservando su volumen

```bash
kubectl cnpg destroy mi-db 1 --keep-pvc
```

Sintaxis: `kubectl cnpg destroy <BD> <INSTANCIA>`, donde **INSTANCIA es el número** (`1` elimina el pod `mi-db-1`). Con `--keep-pvc` el volumen se conserva separado de la instancia, para borrarlo tú después. Sin ese flag borra el pod **y** sus PVC a la vez.

**Esperado:** `Instance mi-db-1 of cluster mi-db has been destroyed and the PVC was kept`.

Elegir tú la instancia con `destroy` evita depender de la lógica automática al reducir `instances`. Una fuente de terceros (documentación del operador de Splunk sobre CNPG, no la oficial) dice que al reducir `instances` nunca se elimina el primario y se quita la réplica de serial más alto. **No se verificó en la documentación oficial**, y en este caso el primario tenía justo el serial más alto, por eso no se confió en eso.

## A3. Bajar `instances` a 1 de inmediato

```bash
sed -i 's/instances: 2/instances: 1/' mi-db.yaml
grep -n "instances" mi-db.yaml
kubectl apply -f mi-db.yaml
```

Se hace enseguida porque **no se verificó** qué haría el operador si `instances` se quedara en 2 tras el `destroy` (podría recrear una instancia). En el ensayo no recreó ninguna.

## A4. Verificar

Repite hasta que se estabilice (30 a 60 segundos):

```bash
kubectl cnpg status mi-db
kubectl get pods -o wide
kubectl get pvc
kubectl get cluster mi-db -o jsonpath='{.status.currentPrimary}'; echo
kubectl cnpg psql mi-db -- -P pager=off -U postgres app -c "select * from prueba;"
```

**Esperado:**

- `Primary instance: mi-db-2` en el agente destino, `Instances: 1`, `Cluster in healthy state`, `RESTARTS 0`.
- Un solo pod de Postgres.
- El PVC `mi-db-1` **sigue ahí** (por el `--keep-pvc`), junto con `mi-db-2`.
- 4 filas.

Se esperaba ver en el PVC conservado la etiqueta `cnpg.io/pvcStatus=detached` (según la documentación); **en el ensayo no apareció**, solo `instanceRole=replica` y las etiquetas habituales. No se supo por qué. No afectó al resultado, pero no dependas de esa etiqueta.

## A5. Borrar el volumen viejo (irreversible)

Solo cuando las 4 filas estén confirmadas en el primario nuevo:

```bash
kubectl delete pvc mi-db-1
kubectl get pvc
kubectl get pv
```

**Esperado:** solo `mi-db-2` en `pvc` y solo su volumen en `pv`. El `pv` del PVC borrado desaparece (con `local-path` el provisioner lo libera). Desde `kubectl` no se puede confirmar el directorio físico en el nodo; si quieres verlo, mira por SSH la carpeta de volúmenes de `local-path` (por defecto `/var/lib/rancher/k3s/storage/`, de memoria, no verificado).

## A6. Quitar el label del agente de origen

Así la BD no vuelve a programarse allí por accidente. No afecta a `mi-db-2` (el `nodeSelector` solo se evalúa al programar pods nuevos) ni al resto de tus cargas.

```bash
kubectl label node k3s-agent1 db-
kubectl get nodes -L db
kubectl get pods -o wide
```

**Esperado:** `postgres` solo en `k3s-agent2`; `mi-db-2` sigue `1/1 Running` en agent2, `RESTARTS 0`.

## Estado final del traslado

- [ ] Un solo pod de Postgres (`mi-db-2`), primario, en el agente destino.
- [ ] Un solo PVC y un solo PV.
- [ ] `Instances: 1`, `Cluster in healthy state`.
- [ ] Datos íntegros.
- [ ] Label `db=postgres` solo en el agente destino.
- [ ] `mi-db.yaml` con `instances: 1`.

**Para repetir en sentido contrario** (agent2 → agent1): repón el label en agent1, sube a 2 instancias, promueve, elimina la vieja y quita el label de agent2. La nueva instancia se llamará `mi-db-3` (los números siguen subiendo), así que `destroy` se haría sobre `2`.

---

# PARTE B · Desmontar todo el ensayo (opcional, NO ejecutada en el ensayo)

Solo si quieres dejar el k3s como estaba. **Destruye la BD y todos sus datos.** Ejecuta cada bloque por separado y revisa el resultado antes del siguiente. Estos comandos son los habituales, pero no se probaron en esta sesión.

## B1. Borrar la BD

```bash
kubectl delete -f mi-db.yaml
kubectl get pods
kubectl get pvc
kubectl get pv
```

Se espera que desaparezcan el pod y el PVC de `mi-db-2`. **No se verificó** si los PVC se eliminan solos al borrar la BD; si alguno queda, bórralo a mano (`kubectl delete pvc <nombre>`, irreversible).

## B2. Quitar los labels

```bash
kubectl label node k3s-agent2 db-
kubectl get nodes -L db
```

**Esperado:** columna `DB` vacía en todos los nodos.

## B3. Desinstalar el operador

Primero asegúrate de no tener ninguna BD de CNPG (`kubectl get clusters.postgresql.cnpg.io -A` debe decir `No resources found`): al borrar las CRDs se borrarían también los recursos que quedaran.

```bash
kubectl delete -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml
kubectl get pods -n cnpg-system
kubectl get crd | grep cnpg
```

**Esperado:** sin pods ni CRDs de CNPG. **No se verificó** que este sea el procedimiento de desinstalación oficial: contrástalo con la documentación de tu versión antes de usarlo.

## B4. Quitar el plugin (en tu PC)

En el ensayo el binario quedó en `/usr/local/bin/kubectl-cnpg`:

```bash
sudo rm /usr/local/bin/kubectl-cnpg
kubectl plugin list
```

(Si lo instalaste con el `.deb` y quedó en otra ruta, desinstálalo con `apt`/`dpkg` según corresponda.)

## B5. Archivos locales

```bash
rm mi-db.yaml
```

---

## Pendientes y puntos sin verificar de todo el método

- `kubectl port-forward` con TLS muere al cerrar la primera conexión (workaround: `sslmode=disable`; ver archivo 02).
- Qué haría el operador con `instances: 2` tras un `destroy`.
- La etiqueta `detached` no apareció con `--keep-pvc`.
- Corte real de la promoción medido desde un cliente (solo hay marcas de tiempo).
- Replicación síncrona, respaldos y actualización del operador a la última versión parche: no se probaron.
- Un solo server k3s sigue siendo punto único de falla del plano de control.
