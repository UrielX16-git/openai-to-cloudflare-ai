# OpenAI-Compatible Cloudflare AI Proxy

Cloudflare Worker que actúa como proxy intermedio entre la librería oficial de OpenAI y los modelos de **Workers AI** de Cloudflare. Permite usar cualquier cliente OpenAI apuntando al URL del Worker.

## Modelo por defecto

`@cf/nvidia/nemotron-3-120b-a12b`

Puedes cambiar el modelo enviando el campo `model` en la petición. Si no se envía, usa el de arriba como fallback.

## Características

- ✅ Formato de respuesta 100% compatible con OpenAI (`id`, `object`, `created`, `choices`, `usage`)
- ✅ Soporte para **streaming** (SSE)
- ✅ Modelo dinámico — envía cualquier modelo de Workers AI válido en el campo `model`
- ✅ CORS habilitado
- ✅ Despliegue automático con GitHub Actions

## Setup

```bash
npm install
npm run dev      # desarrollo local (remoto)
npm run deploy   # despliegue manual
```

## Despliegue automático (CI/CD)

Este repositorio incluye un workflow de GitHub Actions (`.github/workflows/deploy.yml`).

### Configurar secretos en GitHub

En tu repositorio → Settings → Secrets and variables → Actions, agrega:

| Secreto | Descripción |
|---|---|
| `CF_API_TOKEN` | Token de API de Cloudflare con permisos de Workers |
| `CF_ACCOUNT_ID` | ID de tu cuenta de Cloudflare |

Cada `git push` a `main` o `master` desplegará automáticamente el Worker.

## Uso con Python (openai)

```python
from openai import OpenAI

client = OpenAI(
    api_key="dummy-key",  # Cloudflare Workers AI no requiere API key de OpenAI
    base_url="https://openai-cf-proxy.TU_SUBDOMINIO.workers.dev"
)

# Sin streaming
response = client.chat.completions.create(
    model="@cf/nvidia/nemotron-3-120b-a12b",
    messages=[
        {"role": "system", "content": "Eres un asistente útil."},
        {"role": "user", "content": "¿Cuánto es 3 * 10?"}
    ]
)
print(response.choices[0].message.content)

# Con streaming
stream = client.chat.completions.create(
    model="@cf/nvidia/nemotron-3-120b-a12b",
    messages=[
        {"role": "user", "content": "Cuéntame un chiste corto"}
    ],
    stream=True
)
for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

## Modelos compatibles

Cualquier modelo disponible en [Cloudflare Workers AI](https://developers.cloudflare.com/workers-ai/models/), por ejemplo:

- `@cf/nvidia/nemotron-3-120b-a12b`  (default)
- `@cf/meta/llama-3-8b-instruct`
- `@cf/mistral/mistral-7b-instruct-v0.1`
- `@cf/google/gemma-7b-it`

## Licencia

MIT
