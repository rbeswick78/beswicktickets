document.addEventListener('DOMContentLoaded', () => {
  const transactionModal = document.getElementById('transaction-modal');
  const transactionTableBody = document.querySelector('#transaction-table tbody');
  const modalTitle = document.getElementById('transaction-modal-title');

  // Open the modal function
  window.openTransactionModal = (userId, username) => {
    modalTitle.textContent = `Transactions for ${username}`;

    fetch(`/api/users/${userId}/transactions`)
      .then(response => response.json())
      .then(transactions => {
        // Clear previous transactions
        transactionTableBody.innerHTML = '';

        transactions.forEach(txn => {
          const row = document.createElement('tr');

          // Capitalize the first letter of type
          const transactionType = txn.type.charAt(0).toUpperCase() + txn.type.slice(1);

          const amount = txn.amount;
          const balance = txn.balance;
          const time = new Date(txn.createdAt).toLocaleString();

          row.innerHTML = `
            <td>${transactionType}</td>
            <td>${amount}</td>
            <td>${balance}</td>
            <td>${time}</td>
          `;

          transactionTableBody.appendChild(row);
        });

        transactionModal.classList.remove('hidden');
        transactionModal.classList.add('show');
      })
      .catch(err => console.error('Error fetching transactions:', err));
  };

  // Close the modal when clicking outside of the modal content
  window.addEventListener('click', (event) => {
    if (event.target === transactionModal) {
      transactionModal.classList.add('hidden');
      transactionModal.classList.remove('show');
      modalTitle.textContent = 'User Transactions';
    }
  });
});