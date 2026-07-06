// Edge Function — recebe o arquivo do navegador (mesmo domínio, sem
// problema de CORS) e repassa os bytes DIRETO para o Google Drive em
// streaming, sem guardar o arquivo inteiro na memória do servidor.
//
// Por que Edge e não a função Node normal (como upload-drive.js antigo)?
// Porque funções Node do Vercel têm um limite de tamanho de corpo da
// requisição (alguns MB) — ótimo pra fotos, mas trava em vídeos grandes.
// Edge Functions foram feitas para lidar com streams grandes sem esse limite.

export const config = { runtime: 'edge' };

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  if (!res.ok) throw new Error('Falha ao renovar o access token do Google: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.access_token;
}

async function findFolder(token, name, parentId) {
  const safe = name.replace(/'/g, "\\'");
  const q = parentId
    ? `name='${safe}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${safe}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name)&pageSize=1`;
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Erro ao buscar pasta no Drive: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function createFolder(token, name, parentId) {
  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) body.parents = [parentId];
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Erro ao criar pasta no Drive: ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return { id: data.id, name };
}

async function ensureFolder(token, name, parentId) {
  let folder = await findFolder(token, name, parentId);
  if (!folder) folder = await createFolder(token, name, parentId);
  return folder;
}

export default async function handler(req) {
  if (req.method !== 'PUT') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const url = new URL(req.url);
    const client = url.searchParams.get('client');
    const context = url.searchParams.get('context') || 'Sem contexto';
    const filename = url.searchParams.get('filename');
    const mimeType = url.searchParams.get('mimeType') || 'application/octet-stream';

    if (!client) return new Response(JSON.stringify({ error: 'Nome do cliente é obrigatório' }), { status: 400 });
    if (!filename) return new Response(JSON.stringify({ error: 'Nome do arquivo é obrigatório' }), { status: 400 });

    const token = await getAccessToken();

    const clientesFolder = await ensureFolder(token, 'Clientes', null);
    const clientFolder = await ensureFolder(token, client, clientesFolder.id);
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dateFolder = await ensureFolder(token, `${dateStr} — ${context}`, clientFolder.id);

    // Abre a sessão de upload resumable no Google (servidor-a-servidor)
    const initRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType
      },
      body: JSON.stringify({ name: filename, parents: [dateFolder.id] })
    });
    if (!initRes.ok) {
      const t = await initRes.text().catch(() => '');
      throw new Error('Falha ao abrir sessão de upload (' + initRes.status + '): ' + t.slice(0, 200));
    }
    const uploadUrl = initRes.headers.get('location');
    if (!uploadUrl) throw new Error('Google não retornou a URL de upload esperada.');

    // Repassa os bytes que estão chegando do navegador direto para o Google,
    // em streaming — sem acumular o arquivo inteiro na memória.
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: req.body,
      duplex: 'half'
    });

    if (!uploadRes.ok) {
      const t = await uploadRes.text().catch(() => '');
      throw new Error('O Google recusou o arquivo (' + uploadRes.status + '): ' + t.slice(0, 200));
    }

    const result = await uploadRes.json().catch(() => ({}));
    return new Response(JSON.stringify({ success: true, file: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('upload-stream error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
