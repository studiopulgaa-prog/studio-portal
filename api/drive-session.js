const { google } = require('googleapis');

export const config = {
  api: { bodyParser: true },
};

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

async function findFolderByName(drive, name, parentId) {
  const safeName = name.replace(/'/g, "\\'");
  const query = parentId
    ? `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q: query, spaces: 'drive', fields: 'files(id, name)', pageSize: 1 });
  return res.data.files && res.data.files.length > 0 ? res.data.files[0] : null;
}

async function createFolder(drive, name, parentId) {
  const fileMetadata = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) fileMetadata.parents = [parentId];
  const res = await drive.files.create({ resource: fileMetadata, fields: 'id' });
  return { id: res.data.id, name };
}

async function ensureClientFolder(drive, clientName) {
  let clientesFolder = await findFolderByName(drive, 'Clientes', null);
  if (!clientesFolder) clientesFolder = await createFolder(drive, 'Clientes', null);
  let clientFolder = await findFolderByName(drive, clientName, clientesFolder.id);
  if (!clientFolder) clientFolder = await createFolder(drive, clientName, clientesFolder.id);
  return clientFolder;
}

async function ensureDateFolder(drive, parentFolderId, dateContext) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const folderName = `${dateStr} — ${dateContext}`;
  let dateFolder = await findFolderByName(drive, folderName, parentFolderId);
  if (!dateFolder) dateFolder = await createFolder(drive, folderName, parentFolderId);
  return dateFolder;
}

// Este endpoint NÃO recebe os bytes do arquivo. Ele:
// 1) garante a pasta do cliente/data no Drive
// 2) abre a sessão de upload "resumable" do Google A PARTIR DO SERVIDOR
//    (o servidor consegue ler o cabeçalho "Location" da resposta do Google;
//    o navegador, por causa de CORS, não consegue ler esse cabeçalho de um
//    domínio diferente — por isso a etapa de abertura da sessão precisa
//    acontecer aqui, e não no navegador)
// 3) devolve ao navegador só a URL final, que aí sim recebe o arquivo
//    inteiro DIRETO do navegador para o Google, sem passar pelo Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { client, context, filename, mimeType, size } = req.body || {};
    if (!client) return res.status(400).json({ error: 'Nome do cliente é obrigatório' });
    if (!filename) return res.status(400).json({ error: 'Nome do arquivo é obrigatório' });

    const auth = getAuth();
    const tokenResponse = await auth.getAccessToken();
    const accessToken = typeof tokenResponse === 'string' ? tokenResponse : tokenResponse.token;
    if (!accessToken) throw new Error('Não foi possível obter access token do Google. Verifique as credenciais nas env vars do Vercel.');

    const drive = google.drive({ version: 'v3', auth });
    const clientFolder = await ensureClientFolder(drive, client);
    const dateFolder = await ensureDateFolder(drive, clientFolder.id, context || 'Sem contexto');

    const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType || 'application/octet-stream',
        'X-Upload-Content-Length': String(size || 0)
      },
      body: JSON.stringify({ name: filename, parents: [dateFolder.id] })
    });

    if (!initResponse.ok) {
      const errText = await initResponse.text().catch(() => '');
      throw new Error('Google recusou abrir a sessão de upload (' + initResponse.status + '): ' + errText.slice(0, 200));
    }

    const uploadUrl = initResponse.headers.get('location');
    if (!uploadUrl) throw new Error('Google não retornou a URL de upload esperada.');

    return res.status(200).json({ uploadUrl });
  } catch (error) {
    console.error('drive-session error:', error);
    return res.status(500).json({ error: error.message });
  }
}
