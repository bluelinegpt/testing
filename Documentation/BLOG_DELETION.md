# Delete an unpublished blog

Open the blog editor, choose **Unpublish**, then **Delete article** and confirm.
Publishing permission is required. The API rejects deletion unless the persisted
status is `unpublished`, including requests from stale browser tabs.

Deletion removes the article from the Blog list and prevents detail, preview,
editing and republication through normal routes. This is recoverable removal:
the article is archived and a `deleted` publication-history event is written
atomically, without erasing content, history, tags or shared image files. The
slug remains reserved. There is no self-service restore button.

Deletion, editing and status transitions acquire the same article row lock.
No new schema or direct database writes are required to deploy this feature.
No article is deleted automatically by deployment.
