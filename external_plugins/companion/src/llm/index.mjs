export async function complete(messages, config, { maxTokens = 200 } = {}) {
  const baseUrl = config.llm.base_url || 'http://localhost:11434/v1';

  // Detect Ollama (localhost:11434) and use native API for think: false support
  if (baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434')) {
    return ollamaComplete(messages, config, maxTokens);
  }

  return openaiComplete(messages, config, maxTokens);
}

async function ollamaComplete(messages, config, maxTokens) {
  try {
    const res = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        stream: false,
        think: false,
        options: { num_predict: maxTokens },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.message?.content || null;
  } catch {
    return null;
  }
}

async function openaiComplete(messages, config, maxTokens) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.llm.api_key) {
    headers['Authorization'] = `Bearer ${config.llm.api_key}`;
  }

  try {
    const res = await fetch(`${config.llm.base_url}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.llm.model,
        messages,
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}
