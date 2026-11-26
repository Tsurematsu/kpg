#!/usr/bin/env sh
# Instalador automático de kpg (CloudNativePG TUI Manager)
# Compatible con Ubuntu, Linux Mint, Arch Linux y Fedora (x86_64)
#
# Uso:
#   curl -fsSL https://tsurematsu.github.io/kpg/install.sh | sh
#
# Variables opcionales:
#   KPG_INSTALL_DIR=/usr/local/bin   Directorio de instalación (por defecto /usr/local/bin)
#   KPG_VERSION=latest               Versión/tag a instalar (ej. v1.0.0 o latest)
#   KPG_SKIP_DEPS=1                  Omite la instalación de kubectl y kubectl-cnpg

set -eu

REPO="Tsurematsu/kpg"
INSTALL_DIR="${KPG_INSTALL_DIR:-/usr/local/bin}"
KPG_VERSION="${KPG_VERSION:-latest}"
SKIP_DEPS="${KPG_SKIP_DEPS:-0}"
CNPG_FALLBACK_VERSION="1.29.2"

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

# Instalar un binario en INSTALL_DIR
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

# Descargar e instalar kpg
install_kpg() {
  if [ "$KPG_VERSION" = "latest" ]; then
    KPG_URL="https://github.com/${REPO}/releases/latest/download/kpg-linux"
    info "Descargando la última versión de kpg..."
  else
    KPG_URL="https://github.com/${REPO}/releases/download/${KPG_VERSION}/kpg-linux"
    info "Descargando kpg (${KPG_VERSION})..."
  fi

  curl -fL --progress-bar -o "$TMP_DIR/kpg-linux" "$KPG_URL"
  install_binary "$TMP_DIR/kpg-linux" "kpg"
  ok "kpg instalado en $INSTALL_DIR/kpg"
}

# Resumen final
print_summary() {
  printf "\n${C_BOLD}${C_GREEN}Instalación completada.${C_RESET}\n\n"
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

  install_kpg
  print_summary
}

main "$@"
