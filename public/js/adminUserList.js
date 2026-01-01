// Establish a socket connection
const socket = io();

// Function to render the user list
function renderUserList(users) {
  const userList = document.getElementById('admin-user-list');
  userList.innerHTML = ''; // Clear existing list

  users.forEach(user => {
    const userCard = document.createElement('div');
    userCard.className = 'admin-user-card';
    userCard.dataset.userId = user._id;

    // User info section
    const userInfoContainer = document.createElement('div');
    userInfoContainer.className = 'user-info-container';

    const userName = document.createElement('div');
    userName.className = 'user-name';
    userName.textContent = user.username;

    const removeUserBtn = document.createElement('button');
    removeUserBtn.className = 'remove-user-btn';
    removeUserBtn.dataset.userId = user._id;
    removeUserBtn.dataset.username = user.username;
    removeUserBtn.innerHTML = '<img src="/svg/trash.svg" alt="Remove User" class="icon-svg">';
    removeUserBtn.title = 'Remove User';

    userInfoContainer.appendChild(userName);
    userInfoContainer.appendChild(removeUserBtn);

    // Ticket total display
    const ticketTotal = document.createElement('div');
    ticketTotal.className = 'ticket-balance';
    ticketTotal.textContent = `${user.ticketBalance} tickets`;

    // Buttons container
    const buttonsContainer = document.createElement('div');
    buttonsContainer.className = 'buttons-container';

    const buttonClasses = 'icon-container';

    const addTicketsBtn = document.createElement('button');
    addTicketsBtn.className = 'add-tickets-btn';
    addTicketsBtn.dataset.userId = user._id;
    addTicketsBtn.dataset.username = user.username;
    addTicketsBtn.innerHTML = '<img src="/svg/plus.svg" alt="Add Tickets" class="icon-svg">';
    addTicketsBtn.title = 'Add Tickets';

    const removeTicketsBtn = document.createElement('button');
    removeTicketsBtn.className = 'remove-tickets-btn';
    removeTicketsBtn.dataset.userId = user._id;
    removeTicketsBtn.dataset.username = user.username;
    removeTicketsBtn.innerHTML = '<img src="/svg/minus.svg" alt="Remove Tickets" class="icon-svg">';
    removeTicketsBtn.title = 'Remove Tickets';

    const showTransactionsBtn = document.createElement('button');
    showTransactionsBtn.className = 'show-transactions-btn';
    showTransactionsBtn.dataset.userId = user._id;
    showTransactionsBtn.dataset.username = user.username;
    showTransactionsBtn.innerHTML = '<img src="/svg/history.svg" alt="Transactions" class="icon-svg">';
    showTransactionsBtn.title = 'Transactions';

    // Wrap each button in an icon container
    const addTicketsContainer = document.createElement('div');
    addTicketsContainer.className = buttonClasses;
    addTicketsContainer.appendChild(addTicketsBtn);

    const removeTicketsContainer = document.createElement('div');
    removeTicketsContainer.className = buttonClasses;
    removeTicketsContainer.appendChild(removeTicketsBtn);

    const showTransactionsContainer = document.createElement('div');
    showTransactionsContainer.className = buttonClasses;
    showTransactionsContainer.appendChild(showTransactionsBtn);

    buttonsContainer.appendChild(addTicketsContainer);
    buttonsContainer.appendChild(removeTicketsContainer);
    buttonsContainer.appendChild(showTransactionsContainer);

    userCard.appendChild(userInfoContainer);
    userCard.appendChild(ticketTotal);
    userCard.appendChild(buttonsContainer);

    userList.appendChild(userCard);
  });
}

// Fetch and display all users
fetch('/api/users')
  .then(response => response.json())
  .then(users => {
    renderUserList(users);
  })
  .catch(err => console.error('Error fetching users:', err));

document.addEventListener('DOMContentLoaded', () => {
  const userList = document.getElementById('admin-user-list');

  // Event delegation for user list actions
  userList.addEventListener('click', (event) => {
    if (event.target.closest('.remove-user-btn')) {
      // Handle "Remove User" button click
      const button = event.target.closest('.remove-user-btn');
      const userId = button.dataset.userId;
      const username = button.dataset.username;
      const confirmDelete = confirm(`Are you sure you want to remove user ${username}?`);
      if (confirmDelete) {
        fetch(`/api/users/${userId}`, {
          method: 'DELETE',
        })
          .then(response => response.text())
          .then(message => {
            // alert(message);
          })
          .catch(err => console.error('Error removing user:', err));
      }
    } else if (event.target.closest('.add-tickets-btn')) {
      // Handle "Add Tickets" button click
      const button = event.target.closest('.add-tickets-btn');
      const userId = button.dataset.userId;
      const username = button.dataset.username;
      // Open the Add Tickets Modal
      openAddTicketsModal(userId, username);
    } else if (event.target.closest('.remove-tickets-btn')) {
      // Handle "Remove Tickets" button click
      const button = event.target.closest('.remove-tickets-btn');
      const userId = button.dataset.userId;
      const username = button.dataset.username;
      // Open the Remove Tickets Modal
      openRemoveTicketsModal(userId, username);
    } else if (event.target.closest('.show-transactions-btn')) {
      // Handle "Show Transactions" button click
      const button = event.target.closest('.show-transactions-btn');
      const userId = button.dataset.userId;
      const username = button.dataset.username;
      // Open the Transaction Modal
      openTransactionModal(userId, username);
    }
  });
});

// Function to open Add Tickets Modal
function openAddTicketsModal(userId, username) {
  const ticketModal = document.getElementById('ticket-modal');
  const addTicketsForm = document.getElementById('add-tickets-form');
  const modalTitle = document.getElementById('add-tickets-title');
  ticketModal.classList.remove('hidden'); // Use classList to toggle visibility
  addTicketsForm.dataset.userId = userId;
  modalTitle.textContent = `Add tickets to ${username}`;
}

// Function to open Remove Tickets Modal
function openRemoveTicketsModal(userId, username) {
  const removeTicketModal = document.getElementById('remove-ticket-modal');
  const removeTicketsForm = document.getElementById('remove-tickets-form');
  const modalTitle = document.getElementById('remove-tickets-title');
  removeTicketModal.classList.remove('hidden'); // Use classList to toggle visibility
  removeTicketsForm.dataset.userId = userId;
  modalTitle.textContent = `Remove tickets from ${username}`;
}

// Function to open Transaction Modal
function openTransactionModal(userId, username) {
  const transactionModal = document.getElementById('transaction-modal');
  const transactionTableBody = document.querySelector('#transaction-table tbody');
  const modalTitle = document.getElementById('transaction-modal-title');
  modalTitle.textContent = `Transactions for ${username}`;

  fetch(`/api/users/${userId}/transactions`)
    .then(response => response.json())
    .then(transactions => {
      transactionTableBody.innerHTML = ''; // Clear previous transactions

      transactions.forEach(txn => {
        const row = document.createElement('tr');
        const transactionType = txn.type.charAt(0).toUpperCase() + txn.type.slice(1);
        const amount = txn.amount;
        const balance = txn.balance;
        const time = new Date(txn.createdAt).toLocaleString();

        row.innerHTML = `
          <td class="border px-4 py-2">${transactionType}</td>
          <td class="border px-4 py-2">${amount}</td>
          <td class="border px-4 py-2">${balance}</td>
          <td class="border px-4 py-2">${time}</td>
        `;

        transactionTableBody.appendChild(row);
      });

      transactionModal.classList.remove('hidden'); // Use classList to toggle visibility
    })
    .catch(err => console.error('Error fetching transactions:', err));
}

// Socket.IO events to update the UI in real-time
socket.on('newUser', (data) => {
  // Fetch the updated user list
  fetch('/api/users')
    .then(response => response.json())
    .then(users => {
      renderUserList(users);
    })
    .catch(err => console.error('Error fetching users:', err));
});

socket.on('userDeleted', (data) => {
  const { userId } = data;
  const userCard = document.querySelector(`.admin-user-card[data-user-id="${userId}"]`);
  if (userCard) {
    userCard.remove();
  }
});

socket.on('ticketUpdate', (data) => {
  const { userId, ticketBalance } = data;
  const userCard = document.querySelector(`.admin-user-card[data-user-id="${userId}"]`);
  if (userCard) {
    const balanceElement = userCard.querySelector('.ticket-balance');
    if (balanceElement) {
      balanceElement.textContent = `${ticketBalance} tickets`;
    }
  }
});

// Ensure no conflicts with other modals
window.addEventListener('click', (event) => {
  // Existing modal close handlers...
  
  // Close QR Code Modal
  const qrCodeModal = document.getElementById('qr-code-modal');
  if (event.target === qrCodeModal) {
    qrCodeModal.classList.add('hidden');
    qrCodeModal.classList.remove('show');
    const generateQRForm = document.getElementById('generate-qr-form');
    const qrCodeResult = document.getElementById('qr-code-result');
    generateQRForm.reset();
    qrCodeResult.classList.add('hidden');
  }
});