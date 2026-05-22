<h1 align="center">codex-bridge</h1>

<p align="center">
  Un proxy local sin dependencias que permite a <a href="https://github.com/openai/codex">Codex CLI</a> comunicarse con
  <strong>DeepSeek</strong>, <strong>Xiaomi MiMo</strong> y <strong>OpenAI</strong> a través de una sola
  <code>base_url</code>.
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-18%2B-339933?logo=node.js&logoColor=white" alt="Node.js 18+"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="Licencia MIT"></a>
  <img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="Sin dependencias">
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <strong>Español</strong>
</p>

---

Codex CLI usa la **OpenAI Responses API**. DeepSeek y MiMo usan **Chat Completions**.
codex-bridge traduce entre ambos en ambas direcciones — SSE de streaming, llamadas a herramientas y viajes de ida y vuelta del modo de pensamiento — para que puedas usar cualquier modelo compatible dentro de Codex sin modificar el cliente.

## Características

- **Enrutamiento multi-proveedor** — DeepSeek / MiMo / MiniMax / OpenAI / Personalizado, seleccionado automáticamente por nombre de modelo
- **Traducción de protocolo bidireccional** — Responses API ↔ Chat Completions con puente SSE de streaming
- **Traducción de esfuerzo de razonamiento por proveedor** — `none | minimal | low | medium | high | xhigh` de Codex mapeado al formato nativo de cada proveedor
- **Viaje de ida y vuelta de llamadas a herramientas en modo de pensamiento** — almacena en caché `reasoning_content` y lo reproduce para que el modo de pensamiento de DeepSeek sobreviva a llamadas de herramientas de múltiples turnos
- **Puerta de autenticación de entrada** — `PROXY_AUTH_KEY` / `PROXY_KEYS` con bloqueo de proveedor opcional por clave
- **Continuidad de sesión** — `previous_response_id` funciona entre proveedores (almacén limitado por LRU)
- **Herramienta `web_fetch` integrada** — evita restricciones de sandbox en conversaciones con muchas URLs
- **Cortacircuitos de llamadas a herramientas** — advertencia suave + eliminación forzada de herramientas en bucles infinitos
- **Archivo único, sin dependencias** — un solo `proxy.mjs` (~2000 líneas), sin `npm install`

## Inicio rápido

### 1. Configurar

```bash
git clone https://github.com/wujfeng712-ui/codex-bridge.git
cd codex-bridge
cp env.example .env
```

Edita `.env` — como mínimo:

```bash
PROXY_AUTH_KEY=sk-proxy-local-$(openssl rand -hex 24)   # genera una
DEEPSEEK_API_KEY=sk-...                                  # desde platform.deepseek.com
```

```bash
# O usa un proveedor personalizado compatible con OpenAI:
# CUSTOM_BASE_URL=https://your-provider.example.com/v1
# CUSTOM_API_KEY=your-key
# CUSTOM_MODELS=model-a,model-b
# DEFAULT_PROVIDER=custom
```

### 2. Iniciar el proxy

```bash
node --env-file=.env proxy.mjs
```

> ¿Usas Node 18–19 o modo en segundo plano? Consulta [Uso avanzado](#uso-avanzado).

### 3. Apuntar Codex CLI al proxy

Edita `~/.codex/config.toml`:

```toml
model = "deepseek-v4-flash"
model_provider = "local_proxy"

[model_providers.local_proxy]
name = "local_proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "responses"
requires_openai_auth = true
```

Configura la clave de autenticación para Codex:

```bash
# ~/.codex/auth.json
{ "OPENAI_API_KEY": "<misma PROXY_AUTH_KEY de .env>" }
```

> **¿Usas [CC Switch](https://github.com/farion1231/cc-switch)?** Omite la edición manual — añade un proveedor en la interfaz gráfica. Consulta [Uso con CC Switch](#uso-con-cc-switch).

Ejecuta `codex` — listo.

## Arquitectura

```
┌─────────────┐    Responses API    ┌──────────────┐
│  Codex CLI  │────────────────────▶│ codex-bridge │
│             │  Authorization:     │    :4000     │
└─────────────┘  Bearer <key>       └──────┬───────┘
                                           │  enrutamiento por modelo
                   ┌───────────────────────┼────────────────────────┬───────────────────────┐
                   │                       │                        │                       │
                   ▼                       ▼                        ▼                       ▼
          ┌────────────────┐      ┌────────────────┐       ┌──────────────┐       ┌────────────────┐
          │   DeepSeek V4  │      │  Xiaomi MiMo   │       │    OpenAI    │       │ Personalizado  │
          │ Chat Complet.  │      │ Chat Complet.  │       │  Responses   │       │ Chat Complet.  │
          └────────────────┘      └────────────────┘       └──────────────┘       └────────────────┘
```

## Configuración

Todos los ajustes se configuran mediante variables de entorno (consulta `env.example` para la documentación completa):

### Autenticación

| Variable | Predeterminado | Descripción |
|---|---|---|
| `PROXY_AUTH_KEY` | — | Clave de entrada única (sin bloqueo de proveedor) |
| `PROXY_KEYS` | — | Tabla multi-clave: `<key>:<provider>,...` donde provider ∈ `deepseek`/`mimo`/`minimax`/`openai`/`custom`/`*` |

Ambas vacías = autenticación deshabilitada (no recomendado).

### Proveedores

| Variable | Predeterminado | Descripción |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Clave de DeepSeek |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com/v1` | URL base de DeepSeek |
| `DEEPSEEK_MODELS` | `deepseek-v4-pro,deepseek-v4-flash` | Modelos a anunciar |
| `MIMO_API_KEY` | — | Clave de Xiaomi MiMo |
| `MIMO_BASE_URL` | `https://token-plan-cn.xiaomimimo.com/v1` | URL base de MiMo |
| `MIMO_MODELS` | `mimo-v2.5-pro` | Modelos a anunciar (**deben estar en minúsculas**) |
| `OPENAI_API_KEY` | — | Clave de OpenAI (opcional) |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | URL base de OpenAI |
| `OPENAI_MODELS` | — | Lista explícita de modelos de OpenAI |
| `OPENAI_MODEL_PREFIXES` | `gpt-,o1,o3,o4,codex-,chatgpt-` | Prefijos de enrutamiento heurístico |
| `CUSTOM_API_KEY` | — | Clave del proveedor personalizado (opcional) |
| `CUSTOM_BASE_URL` | — | URL base del proveedor personalizado (**obligatoria** si se establece `CUSTOM_API_KEY`) |
| `CUSTOM_MODELS` | — | Lista de modelos del proveedor personalizado (separados por comas) |

### Catálogo de modelos

| Variable | Predeterminado | Descripción |
|---|---|---|
| `MODEL_CATALOG_PATH` | — | Ruta a un archivo `proxy-models.json`. Sobrescribe las variables `*_MODELS`. Mismo archivo que Codex lee vía `model_catalog_json` |

### Ajustes

| Variable | Predeterminado | Descripción |
|---|---|---|
| `PROXY_PORT` | `4000` | Puerto de escucha |
| `DEFAULT_PROVIDER` | auto | Proveedor de reserva cuando el modelo es desconocido (`deepseek` / `mimo` / `openai` / `custom` / `auto`) |
| `LOG_LEVEL` | `info` | `silent` / `error` / `warn` / `info` / `debug` |
| `ACCESS_LOG` | on | Establece `0` para suprimir los registros de acceso por solicitud |
| `UPSTREAM_TIMEOUT_MS` | `120000` | Tiempo de espera de solicitud al proveedor |
| `STORE_TTL_MS` | `3600000` | TTL de entrada del almacén de respuestas |
| `STORE_MAX` | `500` | Capacidad LRU del almacén de respuestas |
| `GITHUB_TOKEN` | — | Opcional; recurre a `gh auth token` de forma diferida |

## Reglas de enrutamiento

Cada solicitud se enruta por nombre de modelo, en orden de prioridad:

1. **Coincidencia exacta** — el modelo aparece en `DEEPSEEK_MODELS`, `MIMO_MODELS`, `OPENAI_MODELS` o `CUSTOM_MODELS`
2. **Heurística de prefijo** — el modelo comienza con una entrada de `OPENAI_MODEL_PREFIXES` → OpenAI
3. **Pista de nombre** — el modelo contiene `deepseek`, `mimo` o `minimax` → proveedor correspondiente
4. **Reserva** — `DEFAULT_PROVIDER` (incluyendo `custom`), luego el primer proveedor con una clave configurada

## Traducción de esfuerzo de razonamiento

Codex envía `none | minimal | low | medium | high | xhigh`. Cada proveedor acepta un subconjunto diferente:

| Esfuerzo de Codex | DeepSeek | MiMo | OpenAI |
|---|---|---|---|
| `none` | `thinking: {type: "disabled"}` | `thinking: {type: "disabled"}` | campo eliminado |
| `minimal` | `reasoning_effort: "low"` | `reasoning_effort: "low"` | paso directo |
| `low` / `medium` / `high` | paso directo | paso directo | paso directo |
| `xhigh` | `reasoning_effort: "xhigh"` | limitado a `high` | limitado a `high` |

> **Nota:** DeepSeek ignora silenciosamente `enable_thinking: false`. El proxy usa `thinking: {type: "disabled"}` en su lugar.

## Endpoints

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/health` | No | Comprobación de estado |
| `GET` | `/v1/models` | Sí | Lista de modelos combinada |
| `POST` | `/v1/responses` | Sí | Endpoint principal de Codex CLI (Responses API) |
| `POST` | `/v1/chat/completions` | Sí | Paso directo de Chat Completions |
| `GET` | `/cop?url=...` | Sí | Obtención de URL (Jina Reader / HTTP nativo) |
| `POST` | `/cop` | Sí | Obtención de URL con método/encabezados/cuerpo personalizados |

## Prueba de humo

```bash
./scripts/smoke.sh                    # usa localhost:4000 por defecto
./scripts/smoke.sh http://host:4000   # destino personalizado
MODEL=mimo-v2.5-pro ./scripts/smoke.sh  # probar un modelo diferente
```

Ejecuta 30 comprobaciones que cubren endpoints, formas de entrada, puerta de autenticación, completación de streaming, traducción de esfuerzo, viajes de ida y vuelta de llamadas a herramientas y bloqueo de proveedor.

## Uso con CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) es una aplicación de escritorio popular para gestionar perfiles de proveedor en múltiples herramientas CLI de IA (Claude Code, Codex, Gemini CLI, etc.). Puedes usarla para cambiar entre codex-bridge y otros proveedores con un clic.

### Configuración

1. Abre CC Switch → pestaña **Codex** → **Añadir proveedor**
2. Rellena los campos del proveedor:

   | Campo | Valor |
   |---|---|
   | Nombre | `codex-bridge` (o la etiqueta que prefieras) |
   | API Key | Tu `PROXY_AUTH_KEY` de `.env` |
   | Base URL | `http://127.0.0.1:4000/v1` |

3. Haz clic en **Habilitar** para activar — CC Switch escribe la clave en `~/.codex/auth.json` y actualiza `config.toml` automáticamente.

### Cambio entre múltiples proveedores

Si tienes múltiples claves de proveedores (por ejemplo, una para DeepSeek, otra para MiMo), usa `PROXY_KEYS` en `.env` para crear claves de entrada por proveedor:

```bash
PROXY_KEYS=sk-deepseek-aaa:deepseek,sk-mimo-bbb:mimo,sk-all-ccc:*
```

Luego crea un perfil separado en CC Switch para cada clave — cambiar de perfil cambia a qué proveedor codex-bridge enruta.

### Alternativa CLI

Si prefieres la terminal, [cc-switch-cli](https://github.com/SaladDay/cc-switch-cli) ofrece el mismo cambio de perfil sin interfaz gráfica:

```bash
# Listar perfiles
cc-switch list

# Cambiar al perfil codex-bridge
cc-switch use codex-bridge
```

> **Consejo:** Después de cambiar de perfil, reinicia tu terminal (o ejecuta `codex` en un nuevo shell) para que la nueva autenticación surta efecto.

## Uso avanzado

- **Inicio con Node 18–19** — `--env-file` se añadió en Node 20. En versiones anteriores:
  ```bash
  set -a && source .env && set +a && node proxy.mjs
  ```
- **Modo en segundo plano**:
  ```bash
  nohup node --env-file=.env proxy.mjs > /tmp/codex-bridge.log 2>&1 &
  ```
- **Bloqueo de proveedor multi-clave** — asigna cada clave de entrada a un proveedor específico para configuraciones de múltiples perfiles. Consulta `env.example` para el formato de `PROXY_KEYS`.
- **Fuente única del catálogo de modelos** — apunta `MODEL_CATALOG_PATH` al mismo archivo JSON que usa Codex (`model_catalog_json` en `config.toml`) para mantener las listas de modelos sincronizadas automáticamente.

## Inicio automático al arrancar (Windows)

Registra codex-bridge como una tarea programada para que se inicie automáticamente al arrancar el equipo:

```powershell
# Ejecutar como administrador
powershell -ExecutionPolicy Bypass -File .\register-startup.ps1
```

Esto crea una tarea llamada `codex-bridge` que:
- Se inicia al arrancar (no requiere inicio de sesión)
- Se reinicia automáticamente tras un fallo (hasta 3 veces, con 1 minuto de espera)
- Lee la configuración de `.env` automáticamente

**Gestión de la tarea:**

| Acción | Comando |
|---|---|
| Iniciar | `schtasks /Run /TN "codex-bridge"` |
| Detener | `schtasks /End /TN "codex-bridge"` |
| Estado | `schtasks /Query /TN "codex-bridge"` |
| Desinstalar | `powershell -ExecutionPolicy Bypass -File .\unregister-startup.ps1` |

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `EADDRINUSE :4000` | Puerto ya en uso | `lsof -ti:4000 \| xargs kill` o cambia `PROXY_PORT` en `.env` |
| `401 Unauthorized` | Clave de autenticación no coincide | Asegúrate de que `OPENAI_API_KEY` en `~/.codex/auth.json` coincida con `PROXY_AUTH_KEY` en `.env` |
| `--env-file: not recognized` | Node.js < 20 | Usa `set -a && source .env && set +a && node proxy.mjs` |
| Tiempo de espera del proveedor | Respuesta lenta del proveedor | Aumenta `UPSTREAM_TIMEOUT_MS` en `.env` (predeterminado 120 000 ms) |
| Modelo no encontrado | El modelo no está en ninguna lista `*_MODELS` | Añádelo a `DEEPSEEK_MODELS` / `MIMO_MODELS` / `OPENAI_MODELS`, o usa `MODEL_CATALOG_PATH` |

## Requisitos

- Node.js 18+
- macOS / Linux / Windows
- Al menos una clave API de proveedor (DeepSeek, MiMo u OpenAI)

## Licencia

MIT — consulta [LICENSE](./LICENSE).
