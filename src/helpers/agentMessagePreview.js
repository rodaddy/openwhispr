// The chat list's preview: a conversation's latest message that is meant to be
// seen. Grill mode stores its synthetic start turn with metadata
// {"display":"hidden"}; the preview skips it, as the chat view does. Malformed
// metadata counts as visible. Ties on created_at (one second) fall to the
// later row.
function lastVisibleMessageSql(column, conversationIdExpr) {
  return `(SELECT ${column} FROM agent_messages
    WHERE conversation_id = ${conversationIdExpr}
      AND COALESCE(json_extract(CASE WHEN json_valid(metadata) THEN metadata END, '$.display'), '') != 'hidden'
    ORDER BY created_at DESC, id DESC LIMIT 1)`;
}

module.exports = { lastVisibleMessageSql };
