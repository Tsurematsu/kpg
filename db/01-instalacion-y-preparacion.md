# 01 · Instalación y preparación

Método comprobado en un ensayo real: k3s con 1 server y 2 agentes (`k3s-agent1`, `k3s-agent2`), almacenamiento `local-path`, k3s `v1.37.2+k3s1`, operador CloudNativePG `1.29.1`.

**Vocabulario:** "BD" = lo que CNPG llama `Cluster` (un Postgres con su primario y sus réplicas). "Cluster k3s" = tu Kubernetes completo. `kind: Cluster` solo aparece como nombre literal del tipo de recurso.

Los nombres (`mi-db`, `k3s-agent1`, etc.) son los del ensayo: adáptalos.

---

## 1. `kubectl` en tu PC (opcional)

Sirve para no entrar por SSH al server cada vez.

```bash
sudo snap install kubectl --classic
kubectl version --client
```

Traer el archivo de acceso (**si ya tienes `~/.kube/config` con otro cluster, esto lo sobrescribe: haz copia antes**):

```bash
mkdir -p ~/.kube
ssh usuario@IP_DEL_SERVER "sudo cat /etc/rancher/k3s/k3s.yaml" > ~/.kube/config
chmod 600 ~/.kube/config
sed -i 's/127.0.0.1/IP_DEL_SERVER/' ~/.kube/config
kubectl get nodes
```

**Esperado:** los 3 nodos en `Ready`.

- Si da error de certificado, el server necesita `--tls-san` con esa IP. Alternativa sin tocar el server: túnel SSH (`ssh -L 6443:127.0.0.1:6443 usuario@IP_DEL_SERVER`) y omitir el `sed`.
- La versión de `kubectl` debe diferir como máximo una versión menor de la del cluster.
- El `k3s.yaml` da **acceso de administrador total**: trátalo como contraseña maestra y no abras el puerto 6443 a internet.
- Con varios k3s, todos los `k3s.yaml` usan el nombre `default` para cluster, usuario y contexto: renómbralos antes de combinarlos. Verifica con `kubectl config current-context` antes de comandos destructivos.

## 2. Revisar el estado del k3s (solo lectura)

```bash
kubectl version
kubectl get storageclass
kubectl get nodes --show-labels
kubectl get pods -A
```

**Esperado:**

- Cliente y servidor en versiones compatibles.
- StorageClass `local-path (default)`.
- Solo pods del sistema.

**Importante de `local-path`:** usa `WaitForFirstConsumer` (el volumen se crea en el nodo donde cae el primer pod y queda atado a él) y `RECLAIMPOLICY Delete` (**borrar un PVC borra los datos**).

## 3. Instalar el operador CNPG

El operador es **un solo Deployment** en el namespace `cnpg-system`, más CRDs. No es un DaemonSet y no instala nada en los nodos. **No crea ninguna base de datos** hasta que se aplique un recurso `Cluster`.

Antes, comprueba cuál es la última versión parche en https://github.com/cloudnative-pg/cloudnative-pg/releases (en el ensayo se usó la 1.29.1; ya existía la 1.29.2).

```bash
# Comprobar que el manifiesto existe (debe responder HTTP/2 200)
curl -sI https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml | head -n 1

# Instalar. --server-side es obligatorio: las CRDs son muy grandes para el apply normal
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-1.29/releases/cnpg-1.29.1.yaml

# Esperar a que esté listo
kubectl rollout status deployment -n cnpg-system cnpg-controller-manager
kubectl get pods -n cnpg-system -o wide
```

**Esperado:** líneas `serverside-applied` (namespace, 11 CRDs, roles, Service, Deployment, webhooks) y un pod `cnpg-controller-manager-...` en `1/1 Running`. La primera vez tarda por la descarga de la imagen.

- El pod del operador cae en cualquier nodo (lo decide el scheduler); es independiente de dónde viva la BD.
- Si el pod del operador cae, las instancias de Postgres siguen funcionando; solo se pierde la gestión automática (failover, switchover) hasta que vuelva.
- Si más adelante actualizas el operador, sigue usando `--server-side`.

## 4. Instalar el plugin `kubectl cnpg`

Se instala donde esté `kubectl` (tu PC), no en el cluster.

```bash
dpkg --print-architecture        # debe decir amd64
cd /tmp
wget https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.29.2/kubectl-cnpg_1.29.2_linux_x86_64.deb \
  --output-document kube-plugin.deb
sudo dpkg -i kube-plugin.deb

kubectl plugin list
kubectl cnpg --help | head -n 20
```

**Esperado:** `kubectl plugin list` muestra `kubectl-cnpg` y el `--help` lista comandos como `status`, `promote` y `destroy`. En el ensayo el binario quedó en `/usr/local/bin/kubectl-cnpg`.

## 5. Verificación final de esta sección

```bash
kubectl get pods -n cnpg-system
kubectl get clusters.postgresql.cnpg.io -A
kubectl get pvc -A
```

**Esperado:** el pod del operador `Running`, y `No resources found` en los otros dos (todavía no hay ninguna BD).

---

## Notas y puntos sin verificar

- El consumo de RAM del operador es pequeño, pero **no está verificado con cifras**. Puedes ver sus `resources` con:
  `kubectl get deployment -n cnpg-system cnpg-controller-manager -o jsonpath='{.spec.template.spec.containers[0].resources}'`
- Un solo server k3s es punto único de falla del plano de control: sin él, el operador no puede hacer failover ni switchover.

**Siguiente:** `02-crear-bd-en-un-agente.md`.
