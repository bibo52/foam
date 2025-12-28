// End-to-end test for route request/accept flow
const WebSocket = require('ws');

const SERVER_URL = 'ws://localhost:8787';

function createClient(username) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${SERVER_URL}/ws/${username}`);
    const messages = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', username }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      console.log(`[${username}] received:`, msg.type, msg.message || '');
    });

    ws.on('error', reject);

    // Wait for connected + state messages
    setTimeout(() => {
      resolve({ ws, messages, username });
    }, 500);
  });
}

function waitForMessage(client, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = client.messages.find(m => m.type === type);
      if (found) return resolve(found);
      if (Date.now() - start > timeout) return reject(new Error(`Timeout waiting for ${type}`));
      setTimeout(check, 100);
    };
    check();
  });
}

async function test() {
  console.log('=== Route Flow Test ===\n');

  // Use unique usernames to avoid state conflicts
  const ts = Date.now().toString().slice(-4);
  const user1 = `tsta${ts.slice(0,3)}`;
  const user2 = `tstb${ts.slice(0,3)}`;

  console.log(`Creating clients: ${user1}, ${user2}`);

  // Connect both clients
  const client1 = await createClient(user1);
  const client2 = await createClient(user2);

  console.log('\n1. Both clients connected');

  // Verify both got state
  await waitForMessage(client1, 'state');
  await waitForMessage(client2, 'state');
  console.log('2. Both clients received state');

  // Client1 requests route to client2
  console.log(`\n3. ${user1} requesting route to ${user2}...`);
  client1.ws.send(JSON.stringify({ type: 'request_route', to: user2 }));

  // Client2 should receive route_request
  const routeRequest = await waitForMessage(client2, 'route_request');
  console.log(`4. ${user2} received route request from ${routeRequest.from}`);

  // Client2 accepts the route
  console.log(`\n5. ${user2} accepting route...`);
  client2.ws.send(JSON.stringify({ type: 'accept_route', routeId: routeRequest.routeId }));

  // Both should receive route_accepted
  const accepted1 = await waitForMessage(client1, 'route_accepted');
  const accepted2 = await waitForMessage(client2, 'route_accepted');

  console.log(`6. ${user1} received route_accepted`);
  console.log(`7. ${user2} received route_accepted`);

  // Verify route details
  if (accepted1.route && accepted2.route) {
    console.log(`\n=== SUCCESS ===`);
    console.log(`Route created: ${accepted1.route.playerA} <-> ${accepted1.route.playerB}`);
    console.log(`Route ID: ${accepted1.routeId}`);
  } else {
    console.log(`\n=== FAILURE ===`);
    console.log('Route data missing from acceptance message');
  }

  // Check for any errors
  const errors1 = client1.messages.filter(m => m.type === 'error');
  const errors2 = client2.messages.filter(m => m.type === 'error');

  if (errors1.length || errors2.length) {
    console.log('\n=== ERRORS DETECTED ===');
    errors1.forEach(e => console.log(`[${user1}] Error: ${e.message}`));
    errors2.forEach(e => console.log(`[${user2}] Error: ${e.message}`));
  }

  // Cleanup
  client1.ws.close();
  client2.ws.close();

  process.exit(errors1.length || errors2.length ? 1 : 0);
}

test().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
