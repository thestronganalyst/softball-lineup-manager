const KEY = 'data.json';

export async function onRequestGet({ env }) {
  const obj = await env.DATA_BUCKET.get(KEY);
  if (!obj) {
    return new Response('{}', {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return new Response(obj.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'etag': obj.httpEtag,
    },
  });
}

async function writeData(request, env) {
  const body = await request.text();
  try {
    JSON.parse(body);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  await env.DATA_BUCKET.put(KEY, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  return new Response('OK');
}

export const onRequestPut = ({ request, env }) => writeData(request, env);
export const onRequestPost = ({ request, env }) => writeData(request, env);
