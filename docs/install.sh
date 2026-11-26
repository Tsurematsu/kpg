#!/usr/bin/env sh
# Instalador y actualizador automático de kpg (CloudNativePG TUI Manager)
# Compatible con Ubuntu, Linux Mint, Arch Linux y Fedora (x86_64)
#
# Uso (instala o actualiza a la última versión):
#   curl -fsSL https://tsurematsu.github.io/kpg/install.sh | sh
#
# Variables opcionales:
#   KPG_INSTALL_DIR=/usr/local/bin   Directorio de instalación (si ya existe kpg, reutiliza su carpeta)
#   KPG_VERSION=latest               Versión/tag a instalar (ej. v1.1.0 o latest)
#   KPG_FORCE=1                      Fuerza la reinstalación aunque ya tengas la misma versión
#   KPG_SKIP_DEPS=1                  Omite la verificación de kubectl y kubectl-cnpg

set -eu

REPO="Tsurematsu/kpg"
USER_SET_INSTALL_DIR="${KPG_INSTALL_DIR:-}"
INSTALL_DIR="${KPG_INSTALL_DIR:-/usr/local/bin}"
KPG_VERSION="${KPG_VERSION:-latest}"
FORCE_INSTALL="${KPG_FORCE:-0}"
SKIP_DEPS="${KPG_SKIP_DEPS:-0}"
CNPG_FALLBACK_VERSION="1.29.2"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/kpg"
VERSION_STATE_FILE="$STATE_DIR/version"

# Flags opcionales cuando se ejecuta con argumentos (ej. sh install.sh --force)
for arg in "$@"; do
  case "$arg" in
    --force|-f)
      FORCE_INSTALL="1"
      ;;
    --skip-deps)
      SKIP_DEPS="1"
      ;;
  esac
done

# Colores (solo si la salida es una terminal)
if [ -t 1 ]; then
  C_CYAN='\033[0;36m'
  C_GREEN='\033[0;32m'
  C_YELLOW='\033[1;33m'
  C_RED='\033[0;31m'
  C_BOLD='\033[1m'
  C_RESET='\033[0m'
else
  C_CYAN=''
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
  C_BOLD=''
  C_RESET=''
fi

info() { printf "${C_CYAN}[kpg]${C_RESET} %s\n" "$1"; }
ok()   { printf "${C_GREEN}[ok]${C_RESET}  %s\n" "$1"; }
warn() { printf "${C_YELLOW}[!]${C_RESET}   %s\n" "$1"; }
err()  { printf "${C_RED}[err]${C_RESET} %s\n" "$1" >&2; exit 1; }

TMP_DIR=""
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT INT TERM

# Ejecutar con privilegios cuando sea necesario
SUDO=""
setup_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
  elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    SUDO=""
  fi
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif [ -n "$SUDO" ]; then
    $SUDO "$@"
  else
    err "Se requieren permisos de administrador (root o sudo) para ejecutar: $*"
  fi
}

# Verificar sistema operativo y arquitectura
check_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  [ "$OS" = "Linux" ] || err "Este instalador es solo para Linux (detectado: $OS)."

  case "$ARCH" in
    x86_64|amd64) ;;
    *)
      err "Arquitectura no soportada: $ARCH. El binario precompilado de kpg requiere Linux x86_64 (amd64)."
      ;;
  esac
}

# Detectar distribución Linux
DISTRO_ID="unknown"
DISTRO_NAME="Linux"
DISTRO_FAMILY="generic"

detect_distro() {
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_NAME="${PRETTY_NAME:-${NAME:-Linux}}"
    ID_LIKE_VAL="${ID_LIKE:-}"
  else
    ID_LIKE_VAL=""
  fi

  case "$DISTRO_ID" in
    ubuntu|linuxmint|debian|pop)
      DISTRO_FAMILY="debian"
      ;;
    arch|manjaro|endeavouros|cachyos|garuda)
      DISTRO_FAMILY="arch"
      ;;
    fedora)
      DISTRO_FAMILY="fedora"
      ;;
    *)
      case " $ID_LIKE_VAL " in
        *" ubuntu "*|*" debian "*) DISTRO_FAMILY="debian" ;;
        *" arch "*)               DISTRO_FAMILY="arch" ;;
        *" fedora "*)             DISTRO_FAMILY="fedora" ;;
        *)                        DISTRO_FAMILY="generic" ;;
      esac
      ;;
  esac

  info "Sistema detectado: $DISTRO_NAME (familia: $DISTRO_FAMILY)"
}

# Instalar paquetes base necesarios (curl, tar, ca-certificates)
ensure_base_tools() {
  MISSING_TOOLS=""
  for cmd in curl tar; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      MISSING_TOOLS="$MISSING_TOOLS $cmd"
    fi
  done

  if [ -z "$MISSING_TOOLS" ]; then
    return 0
  fi

  info "Instalando herramientas base faltantes:$MISSING_TOOLS"
  case "$DISTRO_FAMILY" in
    debian)
      run_root apt-get update -qq
      run_root apt-get install -y -qq curl tar ca-certificates
      ;;
    arch)
      run_root pacman -Sy --noconfirm --needed curl tar ca-certificates
      ;;
    fedora)
      run_root dnf install -y -q curl tar ca-certificates
      ;;
    *)
      err "Faltan herramientas requeridas:$MISSING_TOOLS. Instálalas manualmente y vuelve a ejecutar el script."
      ;;
  esac
}

# Instalar un binario en INSTALL_DIR (reemplazo seguro incluso si está en uso)
install_binary() {
  src="$1"
  name="$2"
  dest="$INSTALL_DIR/$name"

  if [ ! -d "$INSTALL_DIR" ]; then
    if mkdir -p "$INSTALL_DIR" 2>/dev/null; then
      :
    else
      run_root mkdir -p "$INSTALL_DIR"
    fi
  fi

  if [ -w "$INSTALL_DIR" ]; then
    install -m 0755 "$src" "$dest"
  else
    run_root install -m 0755 "$src" "$dest"
  fi
}

# Detectar instalación existente de kpg y su versión (sin bloquearse con binarios v1.0.0)
EXISTING_KPG=""
INSTALLED_VERSION=""

detect_existing_kpg() {
  if [ -z "$USER_SET_INSTALL_DIR" ] && command -v kpg >/dev/null 2>&1; then
    EXISTING_KPG="$(command -v kpg)"
    INSTALL_DIR="$(dirname "$EXISTING_KPG")"
  elif [ -x "$INSTALL_DIR/kpg" ]; then
    EXISTING_KPG="$INSTALL_DIR/kpg"
  fi

  if [ -z "$EXISTING_KPG" ]; then
    return 0
  fi

  # Usar timeout para no colgarse si hay una v1.0.0 antigua sin soporte --version
  if command -v timeout >/dev/null 2>&1; then
    RAW_VER="$(timeout 2 "$EXISTING_KPG" --version </dev/null 2>/dev/null || true)"
    INSTALLED_VERSION="$(printf '%s\n' "$RAW_VER" | sed -n 's/.*\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[^[:space:]]*\).*/\1/p' | head -n 1 || true)"
  fi

  if [ -z "$INSTALLED_VERSION" ] && [ -r "$VERSION_STATE_FILE" ]; then
    INSTALLED_VERSION="$(head -n 1 "$VERSION_STATE_FILE" | tr -d '[:space:]' || true)"
  fi
}

# Resolver tag objetivo de kpg (ej. v1.1.0)
TARGET_TAG=""

resolve_target_kpg_version() {
  if [ "$KPG_VERSION" != "latest" ]; then
    case "$KPG_VERSION" in
      v*) TARGET_TAG="$KPG_VERSION" ;;
      *)  TARGET_TAG="v$KPG_VERSION" ;;
    esac
    return 0
  fi

  TARGET_TAG="$(
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1 || true
  )"
}

# Descargar kubectl oficial desde dl.k8s.io con verificación SHA-256
install_kubectl_upstream() {
  info "Descargando binario oficial de kubectl..."
  KUBE_VER="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"
  KUBE_URL="https://dl.k8s.io/release/${KUBE_VER}/bin/linux/amd64/kubectl"

  curl -fsSL -o "$TMP_DIR/kubectl" "$KUBE_URL"
  curl -fsSL -o "$TMP_DIR/kubectl.sha256" "${KUBE_URL}.sha256"

  if command -v sha256sum >/dev/null 2>&1; then
    EXPECTED_SHA="$(cat "$TMP_DIR/kubectl.sha256")"
    ACTUAL_SHA="$(sha256sum "$TMP_DIR/kubectl" | awk '{print $1}')"
    if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
      err "Error de verificación SHA-256 al descargar kubectl."
    fi
  fi

  install_binary "$TMP_DIR/kubectl" "kubectl"
  ok "kubectl ${KUBE_VER} instalado en $INSTALL_DIR/kubectl"
}

# Instalar kubectl según la distribución
ensure_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then
    ok "kubectl ya está instalado ($(command -v kubectl))"
    return 0
  fi

  info "kubectl no encontrado. Instalando..."
  case "$DISTRO_FAMILY" in
    arch)
      if run_root pacman -Sy --noconfirm --needed kubectl; then
        ok "kubectl instalado vía pacman"
      else
        warn "No se pudo instalar kubectl con pacman; usando binario oficial."
        install_kubectl_upstream
      fi
      ;;
    fedora)
      if run_root dnf install -y -q kubernetes-client; then
        ok "kubectl instalado vía dnf (kubernetes-client)"
      else
        warn "No se pudo instalar kubernetes-client con dnf; usando binario oficial."
        install_kubectl_upstream
      fi
      ;;
    debian|generic)
      # En Ubuntu/Linux Mint evita depender de snap (deshabilitado por defecto en Mint)
      install_kubectl_upstream
      ;;
  esac
}

# Instalar el plugin kubectl-cnpg
ensure_cnpg_plugin() {
  if command -v kubectl-cnpg >/dev/null 2>&1; then
    ok "Plugin kubectl-cnpg ya está instalado ($(command -v kubectl-cnpg))"
    return 0
  fi

  info "Instalando plugin kubectl-cnpg..."

  CNPG_TAG="$(
    curl -fsSL "https://api.github.com/repos/cloudnative-pg/cloudnative-pg/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1 || true
  )"

  if [ -z "$CNPG_TAG" ]; then
    CNPG_VER="$CNPG_FALLBACK_VERSION"
    CNPG_TAG="v${CNPG_VER}"
    warn "No se pudo consultar la última versión de CNPG; usando ${CNPG_TAG}."
  else
    CNPG_VER="${CNPG_TAG#v}"
  fi

  CNPG_TAR="kubectl-cnpg_${CNPG_VER}_linux_x86_64.tar.gz"
  CNPG_URL="https://github.com/cloudnative-pg/cloudnative-pg/releases/download/${CNPG_TAG}/${CNPG_TAR}"

  curl -fsSL -o "$TMP_DIR/$CNPG_TAR" "$CNPG_URL"
  mkdir -p "$TMP_DIR/cnpg"
  tar -xzf "$TMP_DIR/$CNPG_TAR" -C "$TMP_DIR/cnpg"

  if [ ! -f "$TMP_DIR/cnpg/kubectl-cnpg" ]; then
    err "No se encontró el binario kubectl-cnpg dentro del archivo descargado."
  fi

  install_binary "$TMP_DIR/cnpg/kubectl-cnpg" "kubectl-cnpg"
  ok "kubectl-cnpg ${CNPG_TAG} instalado en $INSTALL_DIR/kubectl-cnpg"
}

# Descargar e instalar o actualizar kpg
ACTION_PERFORMED="installed"
FINAL_VERSION=""

install_or_update_kpg() {
  resolve_target_kpg_version

  if [ -n "$EXISTING_KPG" ]; then
    if [ -n "$INSTALLED_VERSION" ] && [ -n "$TARGET_TAG" ] && [ "$INSTALLED_VERSION" = "$TARGET_TAG" ] && [ "$FORCE_INSTALL" != "1" ]; then
      ok "kpg ya está actualizado en la versión ${INSTALLED_VERSION} (${EXISTING_KPG})."
      info "Si deseas reinstalar de todas formas, ejecuta con KPG_FORCE=1."
      ACTION_PERFORMED="up_to_date"
      FINAL_VERSION="$INSTALLED_VERSION"
      return 0
    fi

    ACTION_PERFORMED="updated"
    FROM_LABEL="${INSTALLED_VERSION:-versión anterior}"
    TO_LABEL="${TARGET_TAG:-latest}"
    info "Actualizando kpg en ${INSTALL_DIR}: ${FROM_LABEL} → ${TO_LABEL}..."
  else
    ACTION_PERFORMED="installed"
    info "Descargando kpg (${TARGET_TAG:-latest})..."
  fi

  if [ -n "$TARGET_TAG" ]; then
    KPG_URL="https://github.com/${REPO}/releases/download/${TARGET_TAG}/kpg-linux"
  else
    KPG_URL="https://github.com/${REPO}/releases/latest/download/kpg-linux"
  fi

  curl -fL --progress-bar -o "$TMP_DIR/kpg-linux" "$KPG_URL"
  if [ ! -s "$TMP_DIR/kpg-linux" ]; then
    err "El binario descargado de kpg está vacío."
  fi

  install_binary "$TMP_DIR/kpg-linux" "kpg"

  # Consultar versión final del binario recién instalado
  if command -v timeout >/dev/null 2>&1; then
    RAW_FINAL="$(timeout 2 "$INSTALL_DIR/kpg" --version </dev/null 2>/dev/null || true)"
    FINAL_VERSION="$(printf '%s\n' "$RAW_FINAL" | sed -n 's/.*\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*[^[:space:]]*\).*/\1/p' | head -n 1 || true)"
  fi
  FINAL_VERSION="${FINAL_VERSION:-${TARGET_TAG:-latest}}"

  # Guardar referencia de versión instalada (best-effort)
  if mkdir -p "$STATE_DIR" 2>/dev/null; then
    printf '%s\n' "$FINAL_VERSION" > "$VERSION_STATE_FILE" 2>/dev/null || true
  fi

  if [ "$ACTION_PERFORMED" = "updated" ]; then
    ok "kpg actualizado a ${FINAL_VERSION} en $INSTALL_DIR/kpg"
  else
    ok "kpg ${FINAL_VERSION} instalado en $INSTALL_DIR/kpg"
  fi
}

# Resumen final
print_summary() {
  printf "\n"
  case "$ACTION_PERFORMED" in
    up_to_date)
      printf "${C_BOLD}${C_GREEN}kpg ya se encuentra en la última versión (${FINAL_VERSION}).${C_RESET}\n\n"
      ;;
    updated)
      printf "${C_BOLD}${C_GREEN}Actualización completada (${FINAL_VERSION}).${C_RESET}\n\n"
      ;;
    *)
      printf "${C_BOLD}${C_GREEN}Instalación completada (${FINAL_VERSION}).${C_RESET}\n\n"
      ;;
  esac

  printf "  Binario kpg:      %s\n" "$INSTALL_DIR/kpg"
  if command -v kubectl >/dev/null 2>&1; then
    printf "  kubectl:          %s\n" "$(command -v kubectl)"
  fi
  if command -v kubectl-cnpg >/dev/null 2>&1; then
    printf "  kubectl-cnpg:     %s\n" "$(command -v kubectl-cnpg)"
  fi

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      printf "\n"
      warn "$INSTALL_DIR no está en tu PATH. Agrégalo con:"
      printf "  export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
      ;;
  esac

  printf "\nAsegúrate de tener configurado tu cluster en ~/.kube/config y ejecuta:\n"
  printf "  ${C_CYAN}kpg${C_RESET}\n\n"
}

main() {
  printf "${C_BOLD}${C_CYAN}kpg — CloudNativePG TUI Manager${C_RESET}\n"
  check_platform
  setup_sudo
  detect_distro
  detect_existing_kpg

  # Si no hay permisos de root ni sudo y el destino por defecto no es escribible, usar ~/.local/bin
  if [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ] && [ ! -w "$INSTALL_DIR" ]; then
    INSTALL_DIR="$HOME/.local/bin"
    warn "Sin acceso a sudo; se instalará en $INSTALL_DIR"
  fi

  TMP_DIR="$(mktemp -d)"

  ensure_base_tools

  if [ "$SKIP_DEPS" = "1" ]; then
    warn "KPG_SKIP_DEPS=1 activo: se omite la verificación de kubectl y kubectl-cnpg."
  else
    ensure_kubectl
    ensure_cnpg_plugin
  fi

  install_or_update_kpg
  print_summary
}

main "$@"
