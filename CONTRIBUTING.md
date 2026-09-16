# Contributing

1. Copy the environment example to a local environment file and use your own
   Firebase project and Notion integration.
2. Install dependencies with Node.js 22:

   npm install
   cd functions
   npm install
   cd ..

3. Run npm test and npm run build before opening a pull request.
4. Do not include media files, private URLs, credentials, generated dist
   output, or Firebase project configuration.

Changes to authentication, CORS, Firestore access, or media proxying need
tests that cover both the authenticated private library and the unauthenticated
Demo routes.
