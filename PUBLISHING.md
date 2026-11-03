# Publishing Yoink to the Chrome Web Store

Do these steps in order. Step 4 matters most: the helper must know the store's ID for the extension, or store users will see "helper not installed".

1. **Merge this branch into `main` on GitHub.** The privacy policy link in the listing points at `main`.
2. **Make a developer account.** Go to https://chrome.google.com/webstore/devconsole and sign in. Google charges a one-time fee.
3. **Upload the extension.** Click **New item** and upload `dist/yoink-store-upload.zip`. Don't submit it yet.
4. **Copy the item ID.** The dashboard shows a 32-letter ID for the new item. Paste it into `STORE_EXTENSION_ID` in `scripts/install.sh` and `$StoreExtensionId` in `scripts/install.ps1`. Then run `./scripts/build.sh` again. (Or send the ID to Claude and it does this part.)
5. **Publish the helper.** On GitHub, open **Releases**, then **Draft a new release**. Use the tag `v0.2.0`. Attach `dist/yoink-helper.zip`, then click **Publish release**. The popup's "Download the Yoink helper" link opens this page.
6. **Fill in the listing.** Copy the text and images from `store/LISTING.md` and `store/images/`.
7. **Fill in the privacy tab.** The answers are in the same file, under "Privacy practices tab".
8. **Submit for review.** Google's review can take a few days or longer.

## Updating later

1. Raise `version` in `extension/manifest.json`.
2. Run `./scripts/build.sh`.
3. Upload the new `dist/yoink-store-upload.zip` on the item's **Package** page and submit it.
4. If the helper changed, attach the new `dist/yoink-helper.zip` to a new GitHub release.

## A note on review

Google reviews what an extension does, not only what its listing says. The listing doesn't name any sites, but the store's rules still apply to the extension's behavior. A rejection email names the rule it was rejected under. Keep it if that happens, so you can fix the right thing.
