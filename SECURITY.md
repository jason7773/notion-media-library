# Security policy

Do not report credentials, private Notion links, or private media URLs in a
public issue. Contact the repository owner privately with a minimal
reproduction.

Never commit environment files, service account JSON, Firebase debug logs, or
Notion temporary URLs. Rotate a credential immediately if it was exposed.

The same-site Demo must use a separate Notion data source containing only
redistributable sample content. Keep the private music and video data sources
separate, and verify every Demo page is published before exposing its asset.
