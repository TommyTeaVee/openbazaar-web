import {
  omit,
  orderBy,
} from 'lodash';
import multihashes from 'multihashes';
import crypto from 'crypto';
import { get as getDb } from 'util/database';
import { eventChannel, END } from 'redux-saga'
import {
  takeEvery,
  put,
  call,
  select,
  spawn,
} from 'redux-saga/effects';
import { animationFrameInterval } from 'util/index';
import { sendMessage as sendChatMessage } from 'util/messaging/index';
import messageTypes from 'util/messaging/types';
import {
  convosRequest,
  convosSuccess,
  convosFail,
  convoChange,
  activateConvo,
  convoActivated,
  convoMessagesRequest,
  convoMessagesSuccess,
  convoMessagesFail,
  messageDbChange,
  // messageChange,
  activeConvoMessagesChange,
  sendMessage,
  cancelMessage,
  convoMarkRead,
} from 'actions/chat';
import { directMessage } from 'actions/messaging';
import { AUTH_LOGOUT } from 'actions/auth';
import sizeOf from 'object-sizeof';

window.orderBy = orderBy;
window.sizeof = sizeOf;

let _messageDocs = null;
let _chatData = null;

window.muchData = () => {
  const promises = [];

  for (var i = 0; i < 1400; i++) {
    promises.push(() => window.inboundChatMessage());
  }

  promises.reduce( async (previousPromise, nextProm) => {
    await previousPromise;
    return nextProm();
  }, Promise.resolve());
}

const _cloneConvo = (base = {}) => {
  return {
    messages: { ...base.messages } || {},
    unread: base.unread || 0,
    _sorted: base._sorted,
    get sorted() {
      if (!this._sorted) {
        this._sorted = orderBy(
          Object.keys(this.messages).map(messageID => ({
            messageID,
            timestamp: this.messages[messageID].timestamp,
          })),
          ['timestamp'],
          ['asc']
        ).map(message => message.messageID);
      }

      return this._sorted;
    },
    set sorted(arr) {
      this._sorted = arr;
    },
  };  
};

const _removeMessage = (peerID, messageID) => {
  if (
    !_chatData[peerID] ||
    !_chatData[peerID].messages ||
    !_chatData[peerID].messages[messageID]
  ) return;
  const convo = _cloneConvo(_chatData[peerID]);
  delete convo.messages[messageID];
  if (
    convo._sorted &&
    convo._sorted.includes(messageID)
  ) {
    convo._sorted.splice(convo._sorted.indexOf(messageID), 1);
  }

  if (!Object.keys(convo.messages).length) {
    delete _chatData[peerID];  
  } else {
    _chatData[peerID] = convo;
  }
}

const _setMessage = (peerID, message) => {
  const convo = _cloneConvo(_chatData[peerID]);
  const prevMessage = convo.messages[message.messageID];
  const curMessage = { ...prevMessage, ...message };

  if (!curMessage.outgoing) {
    if ((prevMessage && prevMessage.read !== curMessage.read)) {
      if (curMessage.read && convo.unread > 0) {
        convo.unread -= 1;
      } else if (!curMessage.read) {
        convo.unread += 1;
      }
    } else if (!prevMessage && !curMessage.read) {
      convo.unread += 1;
    }
  }

  const _sorted = convo._sorted;

  if (_sorted && (!prevMessage || prevMessage.timestamp !== curMessage.timestamp)) {
    // If it's a new message or the timestamp changed and there was already a sorted
    // cached list, we'll try and insert the new message in the right place starting
    // from the bottom, since the vast majority of new messages should be at the end
    // of list.
    let i = _sorted.length;

    while (i > 0 && curMessage.timestamp < convo.messages[_sorted[i - 1]].timestamp) {
      i--;
    }

    convo.sorted = [..._sorted.slice(0, i), curMessage.messageID, ..._sorted.slice(i)];
  }

  convo.messages[curMessage.messageID] = curMessage;

  _chatData[peerID] = convo;
}

const createTimeoutChannel = time =>
  eventChannel(emitter => {
      const timeout = setTimeout(() => {
        emitter('something');
        emitter(END);
      }, time);
      return () => {
        clearInterval(timeout)
      }
    }
  );

let pendingActiveConvoMessageChange = null;

/*
 * This method will dispatch an activeConvoMessagesChange and conditionally
 * debounce it. If the changed data is a message being marked as read or
 * vice-versa, then any such changes will be debounced into a single change
 * action that contains the cumulitive changed data. Otherwise, the change data
 * will immediatally be dispatched.
 */
const dispatchActiveConvoMessagesChangeAction = function* (payload) {
  if (!payload.unreadUpdate) {
    // If it's not an update of the read bool, fire the action right away.
    console.dir(payload);
    yield put(activeConvoMessagesChange(payload));
  } else {
    if (pendingActiveConvoMessageChange) {
      pendingActiveConvoMessageChange.channel.close();
    }

    pendingActiveConvoMessageChange = pendingActiveConvoMessageChange || {};
    pendingActiveConvoMessageChange.channel =
      yield call(createTimeoutChannel, 100);

    const prevPayload = { ...pendingActiveConvoMessageChange.payload } || {};

    pendingActiveConvoMessageChange.payload = {
      messages: {
        ...prevPayload.messages,
        ...payload.messages,
      },
      removed: [
        ...new Set(
          [...prevPayload.removed || [], ...payload.removed || []]
        )
      ],
    }
    
    if (payload.sorted) {
      pendingActiveConvoMessageChange.payload.sorted = payload.sorted;
    } else if (
      pendingActiveConvoMessageChange.payload &&
      pendingActiveConvoMessageChange.payload.sorted
    ) {
      pendingActiveConvoMessageChange.payload.sorted =
        prevPayload.sorted;
    }

    yield takeEvery(pendingActiveConvoMessageChange.channel, function* () {
      yield put(activeConvoMessagesChange(pendingActiveConvoMessageChange.payload));
    });
  }
}

const convoChangeChannels = {};

// todo: when remove:true message is messageID
const setMessage = function* (peerID, message, options = {}) {
  if (!_chatData) {
    throw new Error('The chat data must be populated before calling this function. ' +
      'Please call getChatData().');
  }

  if (typeof message !== 'object') {
    throw new Error('The message must be provided as an object.');
  }

  // todo: not when remove: true 
  if (typeof message.messageID !== 'string' || !message.messageID.length) {
    throw new Error('The message must contain a messageID as a non-empty string.');
  }

  const opts = {
    remove: false,
    ...options,
  };

  const state = yield select();
  const chatData = yield call(getChatData);
  const prevConvo = chatData[peerID];

  opts.remove ?
    _removeMessage(peerID, message) :
    _setMessage(peerID, message);
  
  const curConvo = chatData[peerID];

  const isUpdate = !!(
    !opts.remove &&
    prevConvo &&
    prevConvo.messages[message.messageID]
  );
  const isInsert = !opts.remove && !isUpdate;

  let convoChangeData;

  const setConvoChangeData = (topLevel = {}, data = {}) => {
    convoChangeData = {
      peerID,
      removed: false,
      ...convoChangeData,
      ...topLevel,
      data: {
        ...((convoChangeData && convoChangeData.data) || {}),
        ...data,
      },
    };
  }

  if (!curConvo) {
    if (prevConvo) {
      setConvoChangeData({ removed: true });
    }
  } else {
    if (!prevConvo || prevConvo.unread !== curConvo.unread) {
      setConvoChangeData({}, { unread: curConvo.unread });
    }

    const prevLastMessage = prevConvo ?
      prevConvo.sorted[prevConvo.sorted.length - 1] : null;
    const curLastMessage = curConvo ?
      curConvo.sorted[curConvo.sorted.length - 1] : null;

    if (prevLastMessage !== curLastMessage) {
      setConvoChangeData(
        { message: curConvo.messages[curLastMessage] },
        { lastMessage: curLastMessage }
      );
    }
  }

  let activeConvoMessageChangeData;

  const setActiveConvoMessageChangeData = (data = {}) => {
    activeConvoMessageChangeData = {
      removed: [],
      ...data,
      unreadUpdate:
        isUpdate &&
        prevConvo.messages[message.messageID].read !==
          curConvo.messages[message.messageID].read
    };
  }

  let activeConvoPeerID;

  try {
    activeConvoPeerID = state.chat.activeConvo.peerID;
  } catch {
    // pass
  }

  // For efficiency purposes, there is no actual checking if the message
  // changed. The assumption is if you're calling this method it's with
  // changed message data.
  if (activeConvoPeerID === peerID) {
    if (options.remove) {
      setActiveConvoMessageChangeData({ removed: [ message ] });
    } else {
      const data = {
        messages: {
          [message.messageID]: {
            ...curConvo.messages[message.messageID],
          }
        },
      };

      if (
        isInsert ||
        prevConvo.messages[message.messageID].timestamp !==
          curConvo.messages[message.messageID].timestamp
      ) {
        data.sorted = curConvo.sorted;
      }

      setActiveConvoMessageChangeData(data);
    }
  }

  if (convoChangeData) {
    // We will deobunce the convoChange action so, for example, if you
    // mark a convo as read with 1000 unread messages, it results in only
    // a single convoChange action.
    if (convoChangeChannels[peerID]) {
      convoChangeChannels[peerID].close();
    }

    convoChangeChannels[peerID] = yield call(createTimeoutChannel, 100);

    yield takeEvery(convoChangeChannels[peerID], function* () {
      yield put(convoChange(convoChangeData));
    });
  }

  if (activeConvoMessageChangeData) {
    yield call(dispatchActiveConvoMessagesChangeAction, activeConvoMessageChangeData);
  }
}

// doc me up
const getChatData = async peerID => {
  if (!_chatData) {
    console.time('getMessages');

    let unsentMessages = [];

    if (!_messageDocs) {
      _messageDocs = new Promise((resolve, reject) => {
        let db;

        getDb()
          .then(dbInstance => {
            db = dbInstance;

            console.time('allDocs');

            return Promise.all([
              db.collections.chatmessage.pouch
                .allDocs({
                  include_docs: true,
                }),
              db.collections.unsentchatmessages.pouch
                .allDocs({
                  include_docs: true,
                }),
            ]);
          }).then(docs => {
            console.timeEnd('allDocs');

            // Some weird meta records of some sort are coming in here. For now, we'll
            // just filter them out.
            const filterOutMeta = arr =>
              arr.filter(doc => !doc.id.startsWith('_design'));

            const messagesSent = filterOutMeta(docs[0].rows);
            const messagesUnsent = filterOutMeta(docs[1].rows);

            unsentMessages = messagesUnsent.map(msg => msg.id);

            const combined = messagesUnsent
              .concat(messagesSent);

            console.log(`${combined.length} total messages`);              

            const decrypted = [];

            // todo: don't fail everything if one decrypt fails.
            animationFrameInterval(
              () => {
                const doc = combined[decrypted.length];

                decrypted.push({
                  ...db.collections.chatmessage._crypter.decrypt({
                    ...omit(doc.doc, ['_id']),
                  }),
                  messageID: doc.id,
                });                
              },
              () => decrypted.length < combined.length,
              { maxOpsPerFrame: 25 }
            ).then(() => resolve(decrypted));
          });
      });      
    }

    const docs = await _messageDocs;
    _chatData = {};
    docs.forEach(doc =>
      _setMessage(doc.peerID, {
        ...doc,
        sent: !inTransitMessages[doc.messageID] &&
          !unsentMessages.includes(doc.messageID),
        sending: !!inTransitMessages[doc.messageID],
      }));
    _messageDocs = null;
    console.timeEnd('getMessages');
  }

  return peerID ?
    _chatData[peerID] : _chatData;
};

console.log('milly');
window.milly = getChatData;

function* getConvos(action) {
  try {
    console.time('getConvos');

    const chatData = yield call(getChatData);
    const convos = {};
    const messages = {};

    Object
      .keys(chatData)
      .forEach(peerID => {
        const lastMessage = chatData[peerID].messages[
          chatData[peerID].sorted[
            chatData[peerID].sorted.length - 1
          ]
        ];

        convos[peerID] = {
          unread: chatData[peerID].unread,
          lastMessage: lastMessage.messageID,
        };

        messages[lastMessage.messageID] = lastMessage;
      });

    console.timeEnd('getConvos');
    window.getConvos = convos;

    yield put(convosSuccess({
      convos,
      messages,
    }));
  } catch (e) {
    console.error(e);
    yield put(convosFail(e.message || ''));
  }
}

// TODO: cancel existing async tasks on deactivate convo and logout
// this might make the noAuthNoChat middleware moot.

const getMessagesList = async (db, peerID) => {
  const convoData = await getChatData(peerID);
  let sorted = [];
  let messages = {};

  if (convoData) {
    sorted = convoData.sorted;
    messages = convoData.messages;
  }

  return {
    sorted,
    messages,
  };
};

function* getConvoMessages(action) {
  const peerID = action.payload.peerID;

  try {
    const db = yield call(getDb);
    const messages = yield call(getMessagesList, db, peerID);

    yield put(
      convoMessagesSuccess({
        peerID,
        ...messages,
      })
    );
  } catch (e) {
    yield put(
      convoMessagesFail({
        peerID,
        error: e.message || ''
      })
    );
  }
}

function* handleActivateConvo(action) {
  const peerID = action.payload;

  yield put(convoActivated({ peerID }));
  yield put(convoMessagesRequest({ peerID }));
}

// const convoChangeChannels = {};

function* handleMessageDbChange(action) {
  // if (action.payload.operation === 'DELETE') return;

  // const state = yield select();
  // const {
  //   peerID,
  //   // outgoing,
  //   messageID,
  // } = action.payload.data;
  // const sent = action.payload.sent;  
  // let messageChangeData = null;

  // const setMessageChangeData = () => {
  //   messageChangeData = {
  //     ...omit(action.payload.data, ['_rev']),
  //     sent: sent,
  //     sending: !sent,
  //   };
  // };

  // if (
  //   state.chat.activeConvo &&
  //   state.chat.activeConvo.peerID === peerID
  // ) {
  //   setMessageChangeData();
  // }

  // console.dir(action);

  // const prevConvo = yield call(getChatData, peerID);
  // setMessage(peerID, action.payload.data);
  // const curConvo = yield call(getChatData, peerID);

  // const convoChangeData = { peerID };

  // if (
  //   !prevConvo ||
  //   prevConvo.sorted[prevConvo.sorted.length - 1] !==
  //     curConvo.sorted[curConvo.sorted.length - 1]
  // ) {
  //   convoChangeData.convo = {
  //     lastMessage: curConvo.sorted[curConvo.sorted.length - 1],
  //   };
  //   setMessageChangeData();
  // }

  // if (!prevConvo || prevConvo.unread !== curConvo.unread) {
  //   convoChangeData.convo = {
  //     ...convoChangeData.convo,
  //     unread: curConvo.unread,
  //   };    
  // }

  // // A messageChange action must be dispatched before a convoChange since the former
  // // has data the latter depends on.

  // if (messageChangeData) {
  //   yield put(messageChange(messageChangeData));
  // }

  // if (Object.keys(convoChangeData).length > 1) {
  //   if (convoChangeChannels[peerID]) {
  //     convoChangeChannels[peerID].close();
  //   }

  //   convoChangeChannels[peerID] = yield call(
  //     () => eventChannel(emitter => {
  //         const timeout = setTimeout(() => {
  //           emitter('something');
  //         }, 100);
  //         return () => {
  //           clearInterval(timeout)
  //         }
  //       }
  //     )
  //   );

  //   yield debounce(0, convoChangeChannels[peerID], function* () {
  //     yield put(convoChange(convoChangeData));
  //   });
  // }
}

function generatePbTimestamp(timestamp) {
  if (!(timestamp instanceof Date)) {
    throw new Error('A timestamp must be provided as a Date instance.');
  }

  return {
    seconds: Math.floor(timestamp / 1000),
    nanos: timestamp % 1000,
  };
}

function generateChatMessageData(message, options = {}) {
  if (
    typeof options.timestamp !== 'undefined' &&
    !(options.timestamp instanceof Date)
  ) {
    throw new Error('If providing a timestamp, it must be provided as ' +
      'a Date instance.');
  }

  if (
    typeof options.subject !== 'undefined' &&
    typeof options.subject !== 'string'
  ) {
    throw new Error('If providing a subject, it must be provided as ' +
      'a string.');
  }  

  const opts = {
    subject: '',
    timestamp: new Date(),
    ...options,
  };

  const combinationString = `${opts.subject}!${opts.timestamp.toISOString()}`;
  const idBytes = crypto.createHash('sha256').update(combinationString).digest();
  const idBytesArray = new Uint8Array(idBytes);
  const idBytesBuffer =  new Buffer(idBytesArray.buffer);
  const encoded = multihashes.encode(idBytesBuffer, 0x12);  
  const messageID = multihashes.toB58String(encoded);

  return {
    messageID,
    timestamp: opts.timestamp.toISOString(),
    timestampPB: generatePbTimestamp(opts.timestamp),
  }
}

const inTransitMessages = {};

// todo: doc overloaded retry and explain params difference. Or
// maybe a seperate handleRetryMessage to understand the intent?
function* handleSendMessage(action) {
  const isRetry = !!action.payload.messageID;
  const peerID = action.payload.peerID;
  const message = action.payload.message;
  const generatedChatMessageData = generateChatMessageData(message);
  const messageID = isRetry ?
    action.payload.messageID : generatedChatMessageData.messageID;
  const {
    timestamp,
    timestampPB,
  } = generatedChatMessageData;

  const messageData = {
    messageID,
    peerID,
    message,
    outgoing: true,
    timestamp,
    read: false,
    subject: '',
  }

  inTransitMessages[peerID] = inTransitMessages[peerID] || {};
  inTransitMessages[peerID][messageID] = true;

  // yield put(messageChange({
  //   // todo: constantize this?
  //   type: isRetry ?
  //     'UPDATE' : 'INSERT',
  //   data: {
  //     ...messageData,
  //     sent: false,
  //     sending: true,
  //     // On a retry, we won't update the timestamp in the UI until it succeeds,
  //     // since we don't want the meessagee needlessly changeing sort order.
  //     timestamp: isRetry ?
  //       action.payload.timestamp : timestamp,
  //   },
  // }));

  const db = yield call(getDb);
  let unsentMessageDoc;
  
  try {
    unsentMessageDoc = yield call(
      [db.collections.unsentchatmessages, 'insert'],
      messageData,
    );
  } catch (e) {
    const msg = message.length > 10 ?
      `${message.slice(0, 10)}…` : message;
    console.error(`Unable to save message "${msg}" in the ` +
      'unsent chat messages DB.');
    // We'll just proceed without it. It really just means that if the
    // send fails and the user closes the app, it will be lost.
  }

  let messageSendFailed;

  try {
    yield call(
      sendChatMessage,
      messageTypes.CHAT,
      peerID,
      {
        messageId: messageID,
        subject: messageData.subject,
        message: messageData.message,
        timestamp: timestampPB,
        flag: 0
      }
    );
  } catch (e) {
    const msg = message.length > 10 ?
      `${message.slice(0, 10)}…` : message;
    console.error(`Unable to send the chat message "${msg}".`);
    console.error(e);
    messageSendFailed = true;
  } finally {
    delete inTransitMessages[peerID][messageID];
    // yield put(messageChange({
    //   type: 'UPDATE',
    //   data: {
    //     ...messageData,
    //     sent: !messageSendFailed,
    //     sending: false,
    //     timestamp: isRetry && messageSendFailed ?
    //       action.payload.timestamp : timestamp,
    //   },
    // }));
    if (messageSendFailed) return;
  }

  try {
    yield call(
      [db.collections.chatmessage, 'insert'],
      messageData
    );
  } catch (e) {
    const msg = message.length > 10 ?
      `${message.slice(0, 10)}…` : message;
    console.error(`Unable to save the sent message "${msg}" in the ` +
      'chat messages DB.');
    console.error(e);
    return;
  }

  if (unsentMessageDoc) {
    try {
      yield call([unsentMessageDoc, 'remove']);
    } catch (e) {
      // pass
    }
  }
}

function* handleCancelMessage(action) {
  const messageID = action.payload.messageID;

  if (
    typeof messageID !== 'string' ||
    !messageID
  ) {
    throw new Error('A messageID is required in order to cancel a message.');
  }

  yield 'skippy';
  // yield put(messageChange({
  //   type: 'DELETE',
  //   data: { messageID },
  // }));  

  // const unsentMessage = yield call(getUnsentChatMessage, messageID);
  // if (unsentMessage) yield call([unsentMessage, 'remove']);
}

function* handleConvoMarkRead(action) {
  console.time('markAsRead');

  const peerID = action.payload.peerID;
  const convoData = yield call(getChatData, peerID);
  const updateMessages = Object.keys(convoData.messages || {})
    .filter(messageID => {
      const msg = convoData.messages[messageID];
      return !msg.read && !msg.outgoing;
    });

  console.time('markAsReadSetMessage');

  for (let i = 0; i < updateMessages.length; i++) {
    yield spawn(
      setMessage,
      peerID,
      {
        messageID: updateMessages[i],
        read: true
      });
  }

  console.timeEnd('markAsReadSetMessage');

  const updateMessagesDb = updateMessages
    .filter(messageID => !!convoData.messages[messageID]._rev);
  const encryptedUpdateMessagesDb = [];

  if (!updateMessagesDb.length) {
    console.timeEnd('markAsRead');
    return;
  }

  const db = yield call(getDb);

  console.time('markAsReadEncrypt');
  yield call(
    animationFrameInterval,
    () => {
      const msg = {
        ...convoData.messages[updateMessages[encryptedUpdateMessagesDb.length]]
      };      

      const _rev = msg._rev;
      const _id = msg.messageID;
      delete msg._rev;
      delete msg.messageID;

      if (encryptedUpdateMessagesDb.length < updateMessagesDb.length) {
        encryptedUpdateMessagesDb.push({
          ...db.chatmessage._crypter.encrypt({
            ...msg,
            read: true,
          }),
          _id,
          _rev,
        });
      }
    },
    () => encryptedUpdateMessagesDb.length < updateMessagesDb.length,
    { maxOpsPerFrame: 25 }
  );
  console.timeEnd('markAsReadEncrypt');

  console.time('markAsReadBulkDocs');
  yield call(
    [db.chatmessage.pouch, 'bulkDocs'],
    encryptedUpdateMessagesDb
  );
  console.timeEnd('markAsReadBulkDocs');
  console.timeEnd('markAsRead');
}

function* handleDirectMessage(action) {
  if (action.payload && action.payload.type === messageTypes.CHAT) {
    const peerID = action.payload.peerID;
    const message = action.payload.payload;

    if (message.flag) {
      // ignore "read" and "typing" messages for now
      return;
    }

    const msg = message.message.length > 10 ?
      `${message.message.slice(0, 10)}…` : message.message;    

    console.log(`writing "${msg}" from ${peerID} to the database`);
    console.dir(message);

    const db = yield call(getDb);
    const state = yield select();

    try {
      yield call(
        [db.collections.chatmessage, 'insert'],
        {
          peerID,
          message: message.message,
          messageID: message.messageId,
          timestamp: (
            (new Date(
              Number(
                String(message.timestamp.seconds) +
                String(message.timestamp.nanos)
              )
            )).toISOString()
          ),
          subject: message.subject,
          outgoing: false,
          read: state.chat &&
            state.chat.chatOpen &&
            state.chat.activeConvo &&
            state.chat.activeConvo.peerID === peerID ?
              true : false,
        }
      );
    } catch (e) {
      // TODO: maybe some type of retry? A db insertion failure I would think
      // would be very rare.
      console.error(`Unable to insert direct message ${msg} from ${peerID} ` +
        'into the database.');
      console.error(e);
      return;      
    }
  }
}

function handleMessageChange(action) {
  // if (action.payload.type === 'DELETE') {
  //   delete messagesCache[action.payload.peerID];
  // } else {
  //   messagesCache[action.payload.peerID] = {
  //     ...messagesCache[action.payload.peerID],
  //     ...action.payload,
  //   }
  // }
}

function handleLogout() {
  _messageDocs = null;
  _chatData = null;
}

export function* convosRequestWatcher() {
  yield takeEvery(convosRequest, getConvos);
}

export function* activateConvoWatcher() {
  yield takeEvery(activateConvo, handleActivateConvo);
}

export function* convoMessagesRequestWatcher() {
  yield takeEvery(convoMessagesRequest, getConvoMessages);
}

export function* messageDbChangeWatcher() {
  yield takeEvery(messageDbChange, handleMessageDbChange);
}

// export function* messageChangeWatcher() {
//   yield takeEvery(messageChange, handleMessageChange);
// }

export function* sendMessageWatcher() {
  yield takeEvery(sendMessage, handleSendMessage);
}

export function* convoMarkReadWatcher() {
  yield takeEvery(convoMarkRead, handleConvoMarkRead);
}

export function* directMessageWatcher() {
  yield takeEvery(directMessage, handleDirectMessage);
}

export function* cancelMessageWatcher() {
  yield takeEvery(cancelMessage, handleCancelMessage);
}

export function* logoutWatcher() {
  yield takeEvery(AUTH_LOGOUT, handleLogout);
}