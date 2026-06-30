const { google } = require('googleapis');
const { IncomingForm } = require('formidable');
const fs = require('fs');

export const config = {
  api: { bodyParser: false },
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
  const query = parentId
    ? `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
    : `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
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

async function uploadFile(drive, filepath, filename, mimeType, folderId) {
  const fileMetadata = { name: filename, parents: [folderId] };
  const media = { mimeType, body: fs.createReadStream(filepath) };
  const res = await drive.files.create({ resource: fileMetadata, media, fields: 'id, webViewLink' });
  return res.data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const auth = getAuth();
    const drive = google.drive({ version: 'v3', auth });

    const form = new IncomingForm({ multiples: true, maxFileSize: 500 * 1024 * 1024 });

    const { fields, files } = await new Promise((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const clientName = Array.isArray(fields.client) ? fields.client[0] : fields.client;
    const dateContext = (Array.isArray(fields.context) ? fields.context[0] : fields.context) || 'Sem contexto';

    if (!clientName) return res.status(400).json({ error: 'Client name required' });

    const clientFolder = await ensureClientFolder(drive, clientName);
    const dateFolder = await ensureDateFolder(drive, clientFolder.id, dateContext);

    const fileList = Array.isArray(files.files) ? files.files : (files.files ? [files.files] : []);

    const uploaded = [];
    for (const f of fileList) {
      const result = await uploadFile(drive, f.filepath, f.originalFilename, f.mimetype, dateFolder.id);
      uploaded.push(result);
    }

    return res.status(200).json({ success: true, message: `${uploaded.length} arquivo(s) enviado(s) com sucesso`, files: uploaded });
  } catch (error) {
    console.error('Upload error:', error);
    return res.status(500).json({ error: error.message });
  }
}
