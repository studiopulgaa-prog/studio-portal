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

// Checa se um arquivo realmente chegou no Drive, na pasta esperada.
// Existe porque, em alguns casos, o navegador não consegue ler a resposta
// final do Google (erro de CORS do lado do Google), mesmo quando o
// arquivo foi recebido com sucesso — então em vez de confiar só na
// resposta que o navegador vê, confirmamos direto pelo servidor.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { client, context, filename } = req.body || {};
    if (!client || !filename) return res.status(400).json({ error: 'client e filename são obrigatórios' });

    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const clientesFolder = await findFolderByName(drive, 'Clientes', null);
    if (!clientesFolder) return res.status(200).json({ found: false });

    const clientFolder = await findFolderByName(drive, client, clientesFolder.id);
    if (!clientFolder) return res.status(200).json({ found: false });

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const dateFolder = await findFolderByName(drive, `${dateStr} — ${context || 'Sem contexto'}`, clientFolder.id);
    if (!dateFolder) return res.status(200).json({ found: false });

    const safeName = filename.replace(/'/g, "\\'");
    const q = `name='${safeName}' and '${dateFolder.id}' in parents and trashed=false`;
    const listRes = await drive.files.list({ q, fields: 'files(id, name, size)', pageSize: 1 });
    const found = listRes.data.files && listRes.data.files.length > 0;

    return res.status(200).json({ found, file: found ? listRes.data.files[0] : null });
  } catch (error) {
    console.error('verify-upload error:', error);
    return res.status(500).json({ error: error.message });
  }
}
