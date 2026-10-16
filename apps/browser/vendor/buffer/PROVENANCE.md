# buffer (browser Buffer for isomorphic-git)

isomorphic-git's browser bundle uses a global `Buffer` (`Buffer.from/alloc/concat`, e.g. in its packet-line StreamReader). Browsers have none, so `git.clone` failed in real Chromium with "Missing Buffer dependency" (Node tests did not catch it because Node has a global Buffer). `plugins/core-git/web/browser-git.js` installs this Buffer as `globalThis.Buffer` only when none exists.

`buffer.js` = the unmodified `index.js` of each package below inside small CommonJS wrappers, exported as an ES module.

| Package | Version | License | npm integrity (verified against registry) |
|---|---|---|---|
| buffer | 6.0.3 | MIT | sha512-FTiCpNxtwiZZHEZbcbTIcZjERVICn9yq/pDFkTl95/AxzD1naBctN7YO68riM/gLSDY7sdrMby8hofADYuuqOA== |
| base64-js | 1.5.1 | MIT | sha512-AKpaYlHn8t4SVbOHCy+b5+KKgvR4vrsD8vbvrbiQJps7fKDTkjkDry6ji0rUJjC0kzbNePLwzxq8iypo41qeWA== |
| ieee754 | 1.2.1 | BSD-3-Clause | sha512-dcyqhDvX1C46lXZcVqCpK+FtMRQVdIMN6/Df5js2zouUsqG7I6sFxitIC+7KYK29KdXOLHdu9zL4sFnoVQnqaA== |

License texts: `LICENSE.buffer`, `LICENSE.base64-js`, `LICENSE.ieee754`.

sha256 of buffer.js: 30cf8e6305cba5dc9075fc8f6950e1a1dfc13d541d499481ec6134c4f39c1fe5  apps/browser/vendor/buffer/buffer.js
