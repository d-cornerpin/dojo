// Every tool that sends or uploads a file the caller names, with valid arguments naming that file.

export const UPLOADS = (file: string): Array<[string, Record<string, unknown>]> => [
  ['gmail_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['gmail_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['user_gmail_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['outlook_send', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['outlook_draft', { to: 'someone@example.com', subject: 'Report', body: 'Attached.', attachments: [file] }],
  ['imessage_send', { recipient: 'someone@example.com', text: 'Attached.', attachments: [file] }],
  ['drive_upload', { file_path: file }],
  ['user_drive_upload', { file_path: file }],
  ['onedrive_upload', { file_path: file }],
  ['onedrive_upload_batch', { file_paths: [file] }],
  ['slides_add_image_from_local_path', { presentation_id: 'p1', slide_id: 's1', file_path: file, x_pt: 0, y_pt: 0, width_pt: 10, height_pt: 10 }],
  ['slides_build_slide', { presentation_id: 'p1', elements: [{ kind: 'image_local', x_pt: 0, y_pt: 0, width_pt: 10, height_pt: 10, file_path: file }] }],
];
