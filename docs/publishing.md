# Publishing setup

One-time setup so that pushing a `v*` tag publishes Claude Master everywhere. Day-to-day releasing is in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing).

The [Release workflow](../.github/workflows/release.yml) has three jobs after the build:

| Job | Runs when | Authenticates with |
|---|---|---|
| GitHub Release | always | the workflow's own token |
| VS Code Marketplace | repo variable `AZURE_CLIENT_ID` is set | an Azure managed identity, via OIDC |
| Open VSX | repo variable `OPENVSX_PUBLISH` is `true` | Open VSX trusted publishing, via OIDC |

Neither publish job uses a stored secret. Until a job is set up, it is skipped and the release still succeeds.

## 1. GitHub repository

- The repository must be **public** before the first Marketplace publish. vsce rewrites the README's relative image links to `https://github.com/spajus/vscode-claude-master/raw/HEAD/...`.
- Create an environment named **`publish`** (Settings → Environments). Under deployment branches and tags, allow branch `master` and tags `v*`. Both publish jobs and the Marketplace identity workflow run in it, and the Azure and Open VSX trust settings below are tied to it.

## 2. VS Code Marketplace

Azure DevOps retires global personal access tokens on 2026-12-01, so the Marketplace job signs in with a managed identity instead.

1. **Publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create the publisher **`spajus`** (the ID can't be changed later).
2. **Managed identity.** You need an Azure subscription; the [free account](https://azure.microsoft.com/free) works, and the identity itself costs nothing.
   1. In <https://portal.azure.com>, search for **Managed Identities** → **Create**. Pick the subscription, create a resource group (e.g. `vscode-publishing`), any region, and a name (e.g. `claude-master-publisher`).
      Use a *user-assigned managed identity*; an app registration can sign in but is refused when publishing.
   2. On the new identity: **Settings → Federated credentials → Add credential**.
      Scenario **GitHub Actions deploying Azure resources**, organization `spajus`, repository `vscode-claude-master`, entity **Environment**, environment `publish`. Any credential name.
   3. Note the identity's **Client ID** (Overview) and your **Tenant ID** (Microsoft Entra ID → Overview). Neither is a secret.
3. **Repository variables.**

   ```sh
   gh variable set AZURE_CLIENT_ID --body <client-id>
   gh variable set AZURE_TENANT_ID --body <tenant-id>
   ```

4. **Add the identity to the publisher.** The Marketplace only accepts the identity's *Azure DevOps profile id*, which is not the client, object or resource id.
   1. Actions → **Marketplace identity** → **Run workflow**. The "Print Azure DevOps profile id" step prints `id`. The last step fails for now, which is expected.
   2. In the Marketplace management page: publisher `spajus` → **Members** → **Add**, paste that `id`, role **Contributor**.
   3. Run the workflow again. "Verify it can publish as spajus" now passes.

Microsoft is also preparing *trusted publishing* for the Marketplace (GitHub OIDC straight to the Marketplace, with no Azure identity; vsce already has a hidden `--oidc` flag). Once it's announced, the Marketplace job can switch to it and the Azure identity can be deleted.

## 3. Open VSX

Open VSX is the registry used by Cursor, Windsurf, VSCodium and Gitpod. Trusted publishing can only be registered for an extension that already has a version, so the first version is published by hand.

1. Sign in at <https://open-vsx.org> with GitHub. In your settings, log in with an Eclipse account and sign the **Publisher Agreement**.
2. Settings → **Access Tokens** → generate a token. Then, from this repository:

   ```sh
   npx ovsx create-namespace spajus -p <token>
   npm run package
   npx ovsx publish claude-master-<version>.vsix -p <token>
   ```

3. Register trusted publishing at <https://open-vsx.org/user-settings/trusted-publishers>: provider **GitHub**, repository `spajus/vscode-claude-master`, workflow `release.yml`, environment `publish`.
4. Turn the job on, then delete the access token on open-vsx.org:

   ```sh
   gh variable set OPENVSX_PUBLISH --body true
   ```

A new namespace shows as unverified. To get the verified badge, [claim the namespace](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access).

## Publishing before the setup is done

The GitHub Release always has the `.vsix` attached. To publish it by hand:

- **Marketplace:** on <https://marketplace.visualstudio.com/manage>, publisher `spajus` → **New extension** → **Visual Studio Code**, and drop the `.vsix`. For later versions use **Update** from the extension's `…` menu.
- **Open VSX:** `npx ovsx publish <file>.vsix -p <token>`.

The Marketplace takes a few minutes to scan a new version before it appears.
