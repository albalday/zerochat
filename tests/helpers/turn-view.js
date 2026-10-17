// Vistas en memoria con el contrato de ChatUIConversation.createTurnView y
// ChatToolCards.createCardView: registran lo que pintaría la interfaz para probar ChatEngine y
// AgentCore sin DOM. La interfaz real la cubren las pruebas de navegador.

/**
 * Vista de tarjetas. `authorize(toolCall, authorization)` responde a las peticiones de
 * autorización como lo haría el usuario en la tarjeta; sin ella se deniegan.
 */
function createCardView({ authorize = async () => 'deny' } = {}) {
  const opened = [];
  return {
    opened,
    open(name, args, invocationId) {
      const card = { name, args, invocationId, authorizations: [], result: null, completed: false };
      opened.push(card);
      return {
        element: null,
        attachListeners() {},
        nest: () => createCardView({ authorize }),
        requestAuthorization(toolCall, authorization) {
          card.authorizations.push(authorization);
          return authorize(toolCall, authorization);
        },
        complete(result) {
          card.result = result;
          card.completed = true;
        }
      };
    }
  };
}

/** Vista de turno: `blocks` guarda el texto visible de cada bloque en orden. */
function createTurnView(options) {
  const blocks = [];
  const view = {
    blocks,
    resets: 0,
    scrolls: 0,
    createBlock({ reset = false } = {}) {
      if (reset) {
        blocks.length = 0;
        view.resets++;
      }
      const block = { text: '', streaming: false };
      blocks.push(block);
      return {
        render(text, { streaming = false } = {}) {
          block.text = text;
          block.streaming = streaming;
        },
        remove() {
          blocks.splice(blocks.indexOf(block), 1);
        }
      };
    },
    scrollToBottom() {
      view.scrolls++;
    },
    cards: createCardView(options)
  };
  return view;
}

module.exports = { createCardView, createTurnView };
